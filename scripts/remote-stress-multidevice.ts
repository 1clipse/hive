// Single-daemon MULTI-DEVICE concurrency stress driver (M6, H-STRESS-1).
//
// Boots a REAL Hive runtime + a REAL outbound daemon tunnel against a real `ws` multi-device gateway
// stand-in, pairs N phones to the ONE daemon, and drives a configurable wave of concurrent /api
// requests + long-lived terminal io streams across all of them. Exercises the M6 single-daemon
// multi-device goal and H-NET-4 (devices that legitimately allocate the same odd streamId) at a scale
// the in-suite test does not. Prints a pass/fail summary + per-device counts and exits non-zero on any
// dropped/black-holed request, so it is CI-runnable as a smoke gate.
//
// Run:  node_modules/.bin/tsx scripts/remote-stress-multidevice.ts [--devices N] [--rounds R] [--rps]
//
// The 72h soak (real daemon + real phones + real gateway over 4G) is a DEFERRED MANUAL acceptance —
// this script is the runnable, deterministic stand-in, NOT the soak. See docs/remote-stress.md.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteAuditStore } from '../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../src/server/remote-config-keys.js'
import { InMemoryDeviceSessionProvider } from '../src/server/remote-device-session.js'
import { createRemoteTunnel } from '../src/server/remote-tunnel.js'
import Database from '../src/server/sqlite.js'
import { applySchemaVersion23 } from '../src/server/sqlite-schema-v23.js'
import { startMultiDeviceGateway } from '../tests/helpers/multi-device-gateway.js'
import { createTestSession } from '../tests/helpers/remote-test-session.js'
import { startTestServer } from '../tests/helpers/test-server.js'
import { getUiCookie } from '../tests/helpers/ui-session.js'

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const DEVICES = argOf('devices', 8)
const ROUNDS = argOf('rounds', 25)
const PER_DEVICE_INFLIGHT = argOf('inflight', 4)
const TOKEN = 'stress-daemon-token'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (pred: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

async function main(): Promise<void> {
  console.log(
    `[stress:multidevice] devices=${DEVICES} rounds=${ROUNDS} inflight/device=${PER_DEVICE_INFLIGHT}`
  )
  const cleanup: Array<() => Promise<void> | void> = []
  const tmpDirs: string[] = []

  const srv = await startTestServer()
  cleanup.push(() => srv.close())
  const cookie = await getUiCookie(srv.baseUrl)
  const port = Number(new URL(srv.baseUrl).port)

  const daemonId = 'stress-daemon'
  const sessions = Array.from({ length: DEVICES }, (_, i) =>
    createTestSession({ daemonId, deviceId: `device-${i}` })
  )
  const provider = new InMemoryDeviceSessionProvider()
  for (const s of sessions) provider.set(s.daemonSession)

  const db = new Database(':memory:')
  applySchemaVersion23(db)
  const audit = createRemoteAuditStore(db)

  const gateway = await startMultiDeviceGateway({ expectedToken: TOKEN })
  cleanup.push(() => gateway.close())

  const config: RemoteConfigSource = {
    isEnabled: () => true,
    getGatewayUrl: () => gateway.url,
    getDaemonToken: () => TOKEN,
    getDaemonId: () => daemonId,
  }
  const tunnel = createRemoteTunnel({
    loopbackPort: port,
    config,
    deviceSessions: provider,
    loopbackSecret: srv.store.getRemoteTunnelSecret(),
    audit,
    onStatus: () => {},
  })
  cleanup.push(() => tunnel.close())
  tunnel.refresh()
  await waitFor(() => tunnel.status() === 'online', 8000, 'tunnel online')

  // A workspace + a chatty agent so half the devices can hold LIVE terminal io streams open while the
  // others hammer /api — the streamId-collision pressure that H-NET-4 is about.
  const wsPath = mkdtempSync(join(tmpdir(), 'hive-stress-md-'))
  tmpDirs.push(wsPath)
  const script = join(wsPath, 'chatty.js')
  writeFileSync(
    script,
    "setInterval(() => process.stdout.write('tick ' + Date.now() + '\\n'), 30)\nprocess.stdout.write('READY\\n')\nsetInterval(() => {}, 1000)\n"
  )
  const runId = await startAgent(srv.baseUrl, cookie, wsPath, port, script)

  const phones = sessions.map((s) => gateway.addPhone(s.device))

  // Even-indexed devices hold a live terminal io stream (long-lived, owns a low streamId); all devices
  // drive concurrent /api waves so their fresh stream ids collide with the held ids.
  let liveOutput = 0
  phones.forEach((p, i) => {
    if (i % 2 === 0) {
      p.ws({ path: `/ws/terminal/${runId}/io`, onData: () => (liveOutput += 1) })
    }
  })
  await waitFor(() => liveOutput > 0, 8000, 'at least one live terminal stream producing')

  let ok = 0
  let bad = 0
  const perDeviceOk = new Map<string, number>()
  const t0 = Date.now()

  for (let round = 0; round < ROUNDS; round++) {
    const wave = phones.flatMap((p) =>
      Array.from({ length: PER_DEVICE_INFLIGHT }, async () => {
        try {
          const r = await p.http({ method: 'GET', path: '/api/workspaces' })
          if (r.status === 200) {
            ok += 1
            perDeviceOk.set(p.deviceId, (perDeviceOk.get(p.deviceId) ?? 0) + 1)
          } else {
            bad += 1
            console.error(`[stress:multidevice] ${p.deviceId} got status ${r.status}`)
          }
        } catch (err) {
          bad += 1
          console.error(
            `[stress:multidevice] ${p.deviceId} request failed:`,
            (err as Error).message
          )
        }
      })
    )
    // Bound each round so a black-holed (hanging) stream surfaces as a failure instead of an infinite
    // wait — exactly the H-NET-4 symptom.
    await Promise.race([
      Promise.all(wave),
      sleep(10000).then(() => {
        throw new Error(`round ${round} did not settle within 10s (likely a black-holed stream)`)
      }),
    ])
  }

  const elapsed = Date.now() - t0
  const expected = ROUNDS * DEVICES * PER_DEVICE_INFLIGHT
  console.log(`[stress:multidevice] ${ok}/${expected} ok, ${bad} failed in ${elapsed}ms`)
  for (const [d, n] of [...perDeviceOk.entries()].sort()) {
    console.log(`  ${d}: ${n} ok`)
  }
  if (perDeviceOk.size !== DEVICES) {
    console.error(
      `[stress:multidevice] FAIL: only ${perDeviceOk.size}/${DEVICES} devices completed any request`
    )
    bad += 1
  }

  for (const fn of cleanup.reverse()) await fn()
  for (const d of tmpDirs) rmSync(d, { force: true, recursive: true })

  if (bad > 0) {
    console.error('[stress:multidevice] FAIL')
    process.exit(1)
  }
  console.log('[stress:multidevice] PASS')
}

async function startAgent(
  baseUrl: string,
  cookie: string,
  wsPath: string,
  port: number,
  script: string
): Promise<string> {
  const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Stress', path: wsPath }),
  })
  const workspace = (await wsRes.json()) as { id: string }
  const workerRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Stressed', role: 'coder' }),
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
  return payload.run_id
}

main().catch((err) => {
  console.error('[stress:multidevice] crashed:', err)
  process.exit(1)
})
