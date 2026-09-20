import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import {
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../../src/server/remote-config-keys.js'
import {
  HIVE_REMOTE_DEVICE_HEADER,
  HIVE_REMOTE_SECRET_HEADER,
} from '../../src/server/remote-loopback-auth.js'
import { createRemoteTunnel, type RemoteTunnel } from '../../src/server/remote-tunnel.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'
import { createPairingCeremony } from '../helpers/remote-test-session.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

// Route-layer + revocation-closed-loop tests for src/server/routes-remote.ts. These run a REAL Hive
// runtime (startTestServer => the persistent device store + pairing engine + audit) plus, where a live
// stream is involved, a REAL `ws` fake gateway carrying a REAL X25519 phone peer over the tunnel and a
// REAL PTY behind /ws/terminal. No node-pty mock, no socket mock, no crypto mock.
//
// The pairing ceremony is driven in-process against the runtime's OWN engine (Option B): the daemon
// half + provider are exactly the ones the routes mutate, so a confirm route and a revoke route are
// observed end-to-end (provider serves/stops serving, the tunnel opens/closes the device's streams).

const TOKEN = 'daemon-token-routes'
const DAEMON_ID = 'daemon-routes'

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

interface Harness {
  server: Awaited<ReturnType<typeof startTestServer>>
  cookie: string
  port: number
  secret: string
  gateway: FakeGateway | null
  tunnel: RemoteTunnel | null
  tempDirs: string[]
}

const harnesses: Harness[] = []

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    if (h.tunnel) await h.tunnel.close()
    if (h.gateway) await h.gateway.close()
    await h.server.close()
    for (const d of h.tempDirs) rmSync(d, { force: true, recursive: true })
  }
})

// A logged-in runtime: enabled + a daemon token + gateway + daemon id seeded so beginPairing succeeds
// and the tunnel wants to connect.
const boot = async (): Promise<Harness> => {
  const server = await startTestServer()
  const cookie = await getUiCookie(server.baseUrl)
  const port = Number(new URL(server.baseUrl).port)
  server.store.settings.setAppState(REMOTE_ENABLED_KEY, 'true')
  server.store.settings.setAppState(REMOTE_GATEWAY_URL_KEY, 'https://gw.example')
  server.store.settings.setAppState(REMOTE_DAEMON_ID_KEY, DAEMON_ID)
  server.store.settings.setAppState(REMOTE_DAEMON_TOKEN_KEY, TOKEN)
  const h: Harness = {
    server,
    cookie,
    port,
    secret: server.store.getRemoteTunnelSecret(),
    gateway: null,
    tunnel: null,
    tempDirs: [],
  }
  harnesses.push(h)
  return h
}

const api = (h: Harness, path: string, init: RequestInit & { tunnel?: boolean } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.tunnel) {
    // Stamp the per-boot tunnel secret: this is EXACTLY what a phone's loopback request carries, so
    // authorizeRemoteTunnelRequest === true (the trust-root gate must reject the confirm/begin path).
    headers[HIVE_REMOTE_SECRET_HEADER] = h.secret
    headers[HIVE_REMOTE_DEVICE_HEADER] = 'device-tunnel-route-test'
  } else {
    headers.cookie = h.cookie
  }
  return fetch(`${h.server.baseUrl}${path}`, { ...init, headers })
}

// Drive the pairing ceremony against the RUNTIME's own engine + provider, then attach a fake gateway
// carrying the resulting phone peer over a tunnel bound to the store (so revokeRemoteDevice can close
// the device's live streams). Returns the ceremony so callers can revoke via the routes.
//
// Mirrors the REAL flow: the human CONFIRMS at the desktop FIRST (the trust root), THEN the phone
// connects over the relay and runs the M6.1 channel handshake — so the device is already a candidate
// when its sealed Hello arrives and the daemon can bind it (a phone cannot have a usable relay session
// before confirmation). `confirm` defaults to true; pass false to model an unconfirmed phone.
const pairAndConnect = async (h: Harness, opts: { confirm?: boolean } = {}) => {
  const engine = h.server.store.getRemotePairing()
  const provider = h.server.store.getRemoteDeviceSessions()
  const ceremony = createPairingCeremony({ engine, provider })

  if (opts.confirm !== false) {
    const confirmRes = await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, {
      method: 'POST',
    })
    expect(confirmRes.status).toBe(200)
  }

  const gateway = await startFakeGateway({ expectedToken: TOKEN, device: ceremony.device })
  h.gateway = gateway
  const config: RemoteConfigSource = {
    isEnabled: () => true,
    getGatewayUrl: () => gateway.url,
    getDaemonToken: () => TOKEN,
    getDaemonId: () => DAEMON_ID,
  }
  const tunnel = createRemoteTunnel({
    loopbackPort: h.port,
    config,
    deviceSessions: provider,
    loopbackSecret: h.secret,
    audit: h.server.store.getRemoteAuditStore(),
    onStatus: () => {},
  })
  // Bind the tunnel onto the store so the revoke ROUTE's closed loop can tear the device's streams.
  h.server.store.bindRemoteTunnel(tunnel)
  tunnel.refresh()
  await waitFor(() => tunnel.status() === 'online', 4000, 'tunnel online')
  h.tunnel = tunnel
  return ceremony
}

const startAgent = async (h: Harness, workspaceId: string, script: string): Promise<string> => {
  const workerRes = await api(h, `/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
  const worker = (await workerRes.json()) as { id: string }
  const cfg = await api(h, `/api/workspaces/${workspaceId}/agents/${worker.id}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: process.execPath, args: [script] }),
  })
  expect(cfg.status).toBe(204)
  const startRes = await api(h, `/api/workspaces/${workspaceId}/agents/${worker.id}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hive_port: String(h.port) }),
  })
  expect(startRes.status).toBe(201)
  const payload = (await startRes.json()) as { run_id: string }
  return payload.run_id
}

const seedWorkspace = async (h: Harness): Promise<string> => {
  const wsPath = mkdtempSync(join(tmpdir(), 'hive-routes-ws-'))
  h.tempDirs.push(wsPath)
  const res = await api(h, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alpha', path: wsPath }),
  })
  const ws = (await res.json()) as { id: string }
  return ws.id
}

describe('routes-remote — pairing confirm (trust root)', () => {
  it('confirm persists the device, enables the provider, and audits session_open', async () => {
    const h = await boot()
    const engine = h.server.store.getRemotePairing()
    const provider = h.server.store.getRemoteDeviceSessions()
    const ceremony = createPairingCeremony({ engine, provider, proposedName: 'Pixel' })

    // PRE-CONFIRM: the device is not usable; the pending view carries name + SAS (no key material).
    expect(provider.get(ceremony.deviceId)).toBeNull()
    const pendingRes = await api(h, '/api/remote/pairings/pending')
    expect(pendingRes.status).toBe(200)
    const pending = (await pendingRes.json()) as Array<{
      pairing_id: string
      device_name: string | null
      sas: string
      expires_at: number
    }>
    expect(pending).toHaveLength(1)
    expect(pending[0]?.device_name).toBe('Pixel')
    expect(pending[0]?.sas).toMatch(/^\d{6}$/)
    expect(pending[0]).not.toHaveProperty('pairingId')
    expect(pending[0]).not.toHaveProperty('deviceName')
    expect(pending[0]).not.toHaveProperty('expiresAt')
    // The pending view must NOT leak the pairing secret or any key material.
    expect(JSON.stringify(pending)).not.toContain('pairingSecret')

    // CONFIRM at the desktop (cookie path = local).
    const confirmRes = await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, {
      method: 'POST',
    })
    expect(confirmRes.status).toBe(200)
    const confirmed = (await confirmRes.json()) as { device: Record<string, unknown> }
    expect(confirmed.device).toEqual(
      expect.objectContaining({
        created_at: expect.any(Number),
        id: ceremony.deviceId,
        last_active: null,
        name: 'Pixel',
        revoked_at: null,
      })
    )
    expect(confirmed.device).not.toHaveProperty('createdAt')
    expect(confirmed.device).not.toHaveProperty('lastActive')
    expect(confirmed.device).not.toHaveProperty('revokedAt')

    // POST-CONFIRM: the provider serves the device, the device list shows it (no keys), audit row.
    expect(provider.get(ceremony.deviceId)).not.toBeNull()
    const devicesRes = await api(h, '/api/remote/devices')
    const devices = (await devicesRes.json()) as Array<Record<string, unknown>>
    const device = devices.find((d) => d.id === ceremony.deviceId)
    expect(device).toEqual(
      expect.objectContaining({
        created_at: expect.any(Number),
        id: ceremony.deviceId,
        last_active: null,
        name: 'Pixel',
        revoked_at: null,
      })
    )
    expect(device).not.toHaveProperty('createdAt')
    expect(device).not.toHaveProperty('lastActive')
    expect(device).not.toHaveProperty('revokedAt')
    expect(JSON.stringify(devices)).not.toContain('key_')

    await h.server.store.getRemoteAuditStore().flush()
    expect(
      h.server.store
        .getRemoteAuditStore()
        .list()
        .some((r) => r.action === 'session_open' && r.deviceId === ceremony.deviceId)
    ).toBe(true)
  })

  it('a TUNNEL-TAGGED confirm is rejected (403), persists nothing, and audits a forbidden reject', async () => {
    const h = await boot()
    const engine = h.server.store.getRemotePairing()
    const provider = h.server.store.getRemoteDeviceSessions()
    const ceremony = createPairingCeremony({ engine, provider })

    // A phone (tunnel-tagged) tries to self-approve. The trust root forbids it.
    const res = await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, {
      method: 'POST',
      tunnel: true,
    })
    expect(res.status).toBe(403)

    // Nothing was persisted; the provider still returns null; the pairing is still pending.
    expect(provider.get(ceremony.deviceId)).toBeNull()
    expect(h.server.store.getRemoteDeviceStore().list(true)).toEqual([])
    expect(engine.getPending(ceremony.ticket.pairingId)).not.toBeNull()

    // The forged confirm is audited as a reject with the concrete reason (read from the route, not
    // self-fed by the test). HARDEN D0.3: the route enqueues this BEFORE throwing.
    await h.server.store.getRemoteAuditStore().flush()
    const forbidden = h.server.store
      .getRemoteAuditStore()
      .list()
      .find((r) => r.action === 'reject' && r.rejectReason === 'pairing_confirm_forbidden')
    expect(forbidden).toEqual(
      expect.objectContaining({
        deviceId: 'device-tunnel-route-test',
        endpoint: `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`,
      })
    )

    // The same pairing can STILL be confirmed locally — the rejection didn't consume it.
    const ok = await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, {
      method: 'POST',
    })
    expect(ok.status).toBe(200)
    expect(provider.get(ceremony.deviceId)).not.toBeNull()
  })

  it('beginPairing is desktop-only: a tunnel-tagged POST /api/remote/pairings is 403', async () => {
    const h = await boot()
    const res = await api(h, '/api/remote/pairings', { method: 'POST', tunnel: true })
    expect(res.status).toBe(403)
    // The desktop path mints a QR carrying only the M1 PairingPayload fields.
    const ok = await api(h, '/api/remote/pairings', { method: 'POST' })
    expect(ok.status).toBe(200)
    const ticket = (await ok.json()) as { pairing_id: string; qr: string; expires_at: number }
    expect(ticket.pairing_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(ticket.expires_at).toBeGreaterThan(Date.now())
    expect(ticket).not.toHaveProperty('pairingId')
    expect(ticket).not.toHaveProperty('expiresAt')
    const qr = JSON.parse(ticket.qr) as Record<string, unknown>
    expect(Object.keys(qr).sort()).toEqual(['daemonId', 'gatewayUrl', 'pairingSecret', 'v'])
  })

  it('GET pending is desktop-only (a phone cannot read another device’s in-flight SAS)', async () => {
    const h = await boot()
    const engine = h.server.store.getRemotePairing()
    const provider = h.server.store.getRemoteDeviceSessions()
    createPairingCeremony({ engine, provider })
    const res = await api(h, '/api/remote/pairings/pending', { tunnel: true })
    expect(res.status).toBe(403)
  })

  it('the trust-root pairing paths are hard-denied at the BRIDGE too (defense-in-depth)', async () => {
    // A confirmed phone tries to read/approve a NEW pairing over the relay. Layer 1 (the bridge
    // classifyOpen deny) Resets it before any loopback request — the route gate (layer 3) is never even
    // reached. This is the layered trust-root backstop (HARDEN S4).
    const h = await boot()
    // pairAndConnect already confirmed the phone (trust root) before connecting it over the relay.
    await pairAndConnect(h)
    const gateway = h.gateway
    if (!gateway) throw new Error('gateway not connected')

    // Mint a SECOND pairing the phone would try to self-approve over the tunnel.
    const ticket = await (await api(h, '/api/remote/pairings', { method: 'POST' })).json()
    const second = (ticket as { pairing_id: string }).pairing_id
    await expect(
      gateway.openHttp({ method: 'GET', path: '/api/remote/pairings/pending' })
    ).rejects.toThrow()
    await expect(
      gateway.openHttp({ method: 'POST', path: `/api/remote/pairings/${second}/confirm` })
    ).rejects.toThrow()

    await h.server.store.getRemoteAuditStore().flush()
    const audit = h.server.store.getRemoteAuditStore().list()
    // The bridge denied it (path_denied), and it was NEVER forwarded as an http row.
    expect(audit.some((r) => r.action === 'reject' && r.rejectReason === 'path_denied')).toBe(true)
    expect(audit.some((r) => r.action === 'http' && r.endpoint?.endsWith('/pending'))).toBe(false)
    expect(audit.some((r) => r.action === 'http' && r.endpoint?.endsWith('/confirm'))).toBe(false)
  }, 30000)
})

describe('routes-remote — enable gate (D0.4)', () => {
  it('a tunnel-tagged enable:true is 403; enable:false is allowed; local enable:true is allowed', async () => {
    const h = await boot()
    const on = await api(h, '/api/remote/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
      tunnel: true,
    })
    expect(on.status).toBe(403)
    // remote MAY self-disconnect.
    const off = await api(h, '/api/remote/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
      tunnel: true,
    })
    expect(off.status).toBe(200)
    const offStatus = (await off.json()) as Record<string, unknown>
    expect(offStatus.enabled).toBe(false)
    expect(offStatus).toHaveProperty('logged_in')
    expect(offStatus).toHaveProperty('gateway_url')
    expect(offStatus).not.toHaveProperty('loggedIn')
    expect(offStatus).not.toHaveProperty('gatewayUrl')
    expect(h.server.store.settings.getAppState(REMOTE_ENABLED_KEY)?.value).not.toBe('true')
    // Desktop can turn it back on.
    const onLocal = await api(h, '/api/remote/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(onLocal.status).toBe(200)
    const onLocalStatus = (await onLocal.json()) as Record<string, unknown>
    expect(onLocalStatus.enabled).toBe(true)
    expect(onLocalStatus).toHaveProperty('logged_in')
    expect(onLocalStatus).toHaveProperty('gateway_url')
    expect(onLocalStatus).not.toHaveProperty('loggedIn')
    expect(onLocalStatus).not.toHaveProperty('gatewayUrl')
    expect(h.server.store.settings.getAppState(REMOTE_ENABLED_KEY)?.value).toBe('true')
  })
})

describe('routes-remote — revocation closed loop (invariant 5)', () => {
  it('revoking closes the live stream, nulls the provider, and rejects a new stream', async () => {
    const h = await boot()
    // pairAndConnect confirmed at the desktop (trust root) before connecting, so the device is usable.
    const ceremony = await pairAndConnect(h)
    const provider = h.server.store.getRemoteDeviceSessions()
    const gateway = h.gateway
    if (!gateway) throw new Error('gateway not connected')
    expect(provider.get(ceremony.deviceId)).not.toBeNull()

    // Open a live terminal stream over a REAL PTY.
    const workspaceId = await seedWorkspace(h)
    const wsPath = h.tempDirs[h.tempDirs.length - 1] as string
    const script = join(wsPath, 'idle.js')
    writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
    const runId = await startAgent(h, workspaceId, script)
    const stream = await gateway.openWs({ path: `/ws/terminal/${runId}/io` })
    // Confirm the stream is live before revoke (a Reset later proves the close).
    await waitFor(() => !stream.closed(), 2000, 'stream open')

    // REVOKE via the route (equal-authority; here from the desktop). Closed loop:
    //   (1) provider drops the session, (2) the tunnel resets the device's live stream,
    //   (3) audit revoke row, (4) a fresh open is dropped (no_session).
    const revokeRes = await api(h, `/api/remote/devices/${ceremony.deviceId}/revoke`, {
      method: 'POST',
    })
    expect(revokeRes.status).toBe(204)

    // (1) provider null immediately.
    expect(provider.get(ceremony.deviceId)).toBeNull()

    // (2) the in-flight stream is closed by the tunnel.
    await waitFor(() => stream.closed(), 4000, 'revoked stream closed')
    expect(stream.closed()).toBe(true)

    // (3) revoke audit row.
    await h.server.store.getRemoteAuditStore().flush()
    expect(
      h.server.store
        .getRemoteAuditStore()
        .list()
        .some((r) => r.action === 'revoke' && r.deviceId === ceremony.deviceId)
    ).toBe(true)

    // (4) a brand-new stream is refused (no session). The bridge DROPS an unopened frame (it cannot
    //     seal a Reset for a stream it never opened), so the phone's promise never settles — the
    //     observable closed-loop signal is the audit reject row. Fire the open, then assert the row.
    void gateway.openHttp({ method: 'GET', path: '/api/workspaces' }).catch(() => {})
    await waitFor(
      () => {
        const audit = h.server.store.getRemoteAuditStore()
        audit.list() // force a sync flush of pending writes
        return audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'no_session')
      },
      4000,
      'post-revoke frame dropped no_session'
    )
  }, 30000)

  it('the device list reflects the revocation (revoked flag)', async () => {
    const h = await boot()
    // This test exercises the confirm + revoke ROUTES directly (no tunnel request), so it confirms
    // itself rather than relying on pairAndConnect's confirm.
    const ceremony = await pairAndConnect(h, { confirm: false })
    await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, { method: 'POST' })
    await api(h, `/api/remote/devices/${ceremony.deviceId}/revoke`, { method: 'POST' })

    const res = await api(h, '/api/remote/devices?include_revoked=1')
    const devices = (await res.json()) as Array<{ id: string; revoked_at: number | null }>
    const row = devices.find((d) => d.id === ceremony.deviceId)
    expect(row?.revoked_at).not.toBeNull()

    const compatRes = await api(h, '/api/remote/devices?includeRevoked=1')
    const compatDevices = (await compatRes.json()) as Array<{
      id: string
      revoked_at: number | null
    }>
    const compatRow = compatDevices.find((d) => d.id === ceremony.deviceId)
    expect(compatRow?.revoked_at).not.toBeNull()
  }, 30000)
})

describe('routes-remote — status + audit + off', () => {
  it('GET /api/remote/status reports enabled + logged_in + the full connection state', async () => {
    const h = await boot()
    // A transient state the old `connected: boolean` flattened to false, losing all nuance.
    h.server.store.setRemoteTunnelStatus('reconnecting')
    const res = await api(h, '/api/remote/status')
    expect(res.status).toBe(200)
    const status = (await res.json()) as {
      enabled: boolean
      logged_in: boolean
      gateway_url: string | null
      connected: boolean
      connection: string
    }
    expect(status.enabled).toBe(true)
    expect(status.logged_in).toBe(true)
    expect(status.gateway_url).not.toBeNull()
    expect(status).not.toHaveProperty('loggedIn')
    expect(status).not.toHaveProperty('gatewayUrl')
    // The rich tunnel state now survives to the client (it was dropped before).
    expect(status.connection).toBe('reconnecting')
    expect(status.connected).toBe(false) // online shorthand stays correct
  })

  it('GET /api/remote/audit returns rows (read-only), no secrets', async () => {
    const h = await boot()
    const engine = h.server.store.getRemotePairing()
    const provider = h.server.store.getRemoteDeviceSessions()
    const ceremony = createPairingCeremony({ engine, provider })
    await api(h, `/api/remote/pairings/${ceremony.ticket.pairingId}/confirm`, { method: 'POST' })
    const res = await api(h, '/api/remote/audit?limit=50')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<Record<string, unknown>>
    const sessionOpen = rows.find((r) => r.action === 'session_open')
    expect(sessionOpen).toEqual(
      expect.objectContaining({
        action: 'session_open',
        byte_count: null,
        device_id: ceremony.deviceId,
        reject_reason: null,
        workspace_id: null,
      })
    )
    expect(sessionOpen).not.toHaveProperty('byteCount')
    expect(sessionOpen).not.toHaveProperty('deviceId')
    expect(sessionOpen).not.toHaveProperty('rejectReason')
    expect(sessionOpen).not.toHaveProperty('workspaceId')
    expect(JSON.stringify(rows)).not.toContain(h.secret)

    const filteredRes = await api(h, `/api/remote/audit?device_id=${ceremony.deviceId}`)
    expect(filteredRes.status).toBe(200)
    const filteredRows = (await filteredRes.json()) as Array<Record<string, unknown>>
    expect(filteredRows.length).toBeGreaterThan(0)
    expect(filteredRows.every((row) => row.device_id === ceremony.deviceId)).toBe(true)

    const compatFilteredRes = await api(h, `/api/remote/audit?deviceId=${ceremony.deviceId}`)
    expect(compatFilteredRes.status).toBe(200)
    const compatFilteredRows = (await compatFilteredRes.json()) as Array<Record<string, unknown>>
    expect(compatFilteredRows.length).toBeGreaterThan(0)
    expect(compatFilteredRows.every((row) => row.device_id === ceremony.deviceId)).toBe(true)
  })
})
