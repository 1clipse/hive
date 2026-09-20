import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import { createRemoteTunnel, type RemoteTunnel } from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import {
  type MultiDeviceGateway,
  startMultiDeviceGateway,
} from '../helpers/multi-device-gateway.js'
import { createTestSession } from '../helpers/remote-test-session.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Single-daemon MULTI-DEVICE concurrency over the real tunnel: one daemon, one outbound socket, N
// phones multiplexed onto it. Real runtime, real `ws`, real M1 crypto per device. This is the
// in-suite regression home for H-NET-4 — two devices legitimately allocate the SAME odd streamId
// (1,3,5...) and the daemon must not black-hole the second device's stream because the first owns the
// id. The runnable scale version is scripts/remote-stress-multidevice.ts.

const TOKEN = 'daemon-token-multidevice'

const waitFor = async (
  pred: () => boolean,
  timeoutMs = 4000,
  label = 'condition'
): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('remote tunnel — single daemon, multiple devices', () => {
  const tempDirs: string[] = []
  let server: Awaited<ReturnType<typeof startTestServer>> | undefined
  let gateway: MultiDeviceGateway | undefined
  let tunnel: RemoteTunnel | undefined

  beforeEach(() => {
    server = undefined
    gateway = undefined
    tunnel = undefined
  })

  afterEach(async () => {
    if (tunnel) await tunnel.close()
    if (gateway) await gateway.close()
    if (server) await server.close()
    for (const d of tempDirs.splice(0)) rmSync(d, { force: true, recursive: true })
  })

  it('H-NET-4: device B reuses a streamId device A holds LIVE and still gets its 200 (no black-hole)', async () => {
    const srv = await startTestServer()
    server = srv
    const cookie = await getUiCookie(srv.baseUrl)
    const port = Number(new URL(srv.baseUrl).port)
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-hnet4-'))
    tempDirs.push(wsPath)

    // Two devices paired to the SAME daemon. Each gets independent M1 keys; both stream-id allocators
    // start at the same odd ids (1,3,5...), so device B's first stream id collides with device A's.
    const daemonId = 'daemon-shared'
    const a = createTestSession({ daemonId, deviceId: 'device-A' })
    const b = createTestSession({ daemonId, deviceId: 'device-B' })

    const provider = new InMemoryDeviceSessionProvider()
    provider.set(a.daemonSession)
    provider.set(b.daemonSession)

    const db = new Database(':memory:')
    applySchemaVersion23(db)
    const audit = createRemoteAuditStore(db)

    gateway = await startMultiDeviceGateway({ expectedToken: TOKEN })
    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway?.url ?? '',
      getDaemonToken: () => TOKEN,
      getDaemonId: () => daemonId,
    }
    const t = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: provider,
      loopbackSecret: srv.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
    })
    tunnel = t
    t.refresh()
    await waitFor(() => t.status() === 'online', 4000, 'tunnel online')

    // Seed a workspace + a long-lived agent so device A can hold a LIVE terminal io stream open.
    const workspace = await seedWorkspaceAndAgent(srv.baseUrl, cookie, wsPath, port)

    const phoneA = gateway.addPhone(a.device)
    const phoneB = gateway.addPhone(b.device)

    // Device A opens a LIVE terminal io WS (allocates A's streamId 1) and keeps it open — so the daemon
    // binds streamOwner[1] -> device-A and the stream never tears down.
    let aGotOutput = false
    phoneA.ws({
      path: `/ws/terminal/${workspace.runId}/io`,
      onData: () => {
        aGotOutput = true
      },
    })
    await waitFor(() => aGotOutput, 8000, 'device A live stream producing')

    // Now device B's FIRST request also allocates streamId 1 — the SAME id A holds live. With the
    // pre-fix streamOwner-by-id-alone bug, B's Open frame trial-opens ONLY against A's bound key, fails
    // AEAD, and is dropped as open_failed (B's stream is black-holed). With the per-(deviceId,streamId)
    // keying + candidate fall-through, B's frame falls through to a candidate open and reaches the route.
    const rb = await phoneB.http({ method: 'GET', path: '/api/workspaces' })
    expect(rb.status).toBe(200)

    await audit.flush()
    const rows = audit.list().filter((r) => r.action === 'http' && r.endpoint === '/api/workspaces')
    expect(rows.some((r) => r.deviceId === 'device-B')).toBe(true)
  }, 20000)

  it('many concurrent requests across several devices all round-trip', async () => {
    const srv = await startTestServer()
    server = srv
    await getUiCookie(srv.baseUrl)
    const port = Number(new URL(srv.baseUrl).port)
    const wsPath = mkdtempSync(join(tmpdir(), 'hive-multidev-'))
    tempDirs.push(wsPath)

    const daemonId = 'daemon-fan'
    const N = 5
    const sessions = Array.from({ length: N }, (_, i) =>
      createTestSession({ daemonId, deviceId: `device-${i}` })
    )
    const provider = new InMemoryDeviceSessionProvider()
    for (const s of sessions) provider.set(s.daemonSession)

    const db = new Database(':memory:')
    applySchemaVersion23(db)
    const audit = createRemoteAuditStore(db)

    gateway = await startMultiDeviceGateway({ expectedToken: TOKEN })
    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway?.url ?? '',
      getDaemonToken: () => TOKEN,
      getDaemonId: () => daemonId,
    }
    const t = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: provider,
      loopbackSecret: srv.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
    })
    tunnel = t
    t.refresh()
    await waitFor(() => t.status() === 'online', 4000, 'tunnel online')

    const phones = sessions.map((s) => gateway?.addPhone(s.device))

    // Each phone fires 4 concurrent GETs — 20 streams interleaved on the one daemon socket.
    const all = await Promise.all(
      phones.flatMap((p) =>
        Array.from({ length: 4 }, () => p?.http({ method: 'GET', path: '/api/workspaces' }))
      )
    )
    expect(all.length).toBe(N * 4)
    for (const r of all) expect(r?.status).toBe(200)
  }, 20000)
})

// Seed a workspace + a long-lived agent over the direct cookie path, returning its run id so a phone
// can open a LIVE terminal io stream on it. Mirrors the bridge test's startAgent.
async function seedWorkspaceAndAgent(
  baseUrl: string,
  cookie: string,
  wsPath: string,
  port: number
): Promise<{ workspaceId: string; runId: string }> {
  const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alpha', path: wsPath }),
  })
  const workspace = (await wsRes.json()) as { id: string }

  const script = join(wsPath, 'idle.js')
  writeFileSync(
    script,
    "const t = setInterval(() => process.stdout.write('tick\\n'), 50)\nprocess.stdout.write('READY\\n')\nsetInterval(() => {}, 1000)\n"
  )

  const workerRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerRes.json()) as { id: string }
  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: process.execPath, args: [script] }),
  })
  const startRes = await fetch(
    `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: String(port) }),
    }
  )
  const payload = (await startRes.json()) as { run_id: string }
  return { workspaceId: workspace.id, runId: payload.run_id }
}
