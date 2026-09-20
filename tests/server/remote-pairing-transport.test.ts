import { afterEach, describe, expect, it } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
} from '../../src/server/remote-device-store.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import { createRemoteTunnel, type RemoteTunnel } from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'
import { createPairingCeremony } from '../helpers/remote-test-session.js'
import { startTestServer } from '../helpers/test-server.js'

// END-TO-END pairing transport (Option B): the simulated pairing ceremony, the REAL device store +
// persistent provider, the REAL tunnel/bridge, and a REAL `ws` fake gateway play the post-pairing
// relay. A confirmed phone seals frames the daemon resolves through the PERSISTENT provider (not the
// in-memory M3 fixture), and a MITM during pairing makes those frames un-openable end-to-end.
//
// No PTY is mocked: the relay carries genuine /api frames against the live 127.0.0.1 runtime. The one
// piece deferred to M5 is the real gateway pairing-relay socket — here the ceremony drives the engine
// in-process (see tests/unit/remote-pairing-transport-contract.test.ts, the binding M5 contract).

const TOKEN = 'daemon-token-pair-transport'
const DAEMON_ID = 'daemon-pair-transport'

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
  gateway: FakeGateway
  tunnel: RemoteTunnel
  engine: RemotePairing
  provider: ReturnType<typeof createPersistentDeviceSessionProvider>
  store: ReturnType<typeof createRemoteDeviceStore>
  audit: ReturnType<typeof createRemoteAuditStore>
}

describe('remote pairing transport — confirmed phone relays end-to-end; a MITM cannot', () => {
  let harness: Harness | undefined
  const dbs: Database[] = []

  afterEach(async () => {
    if (harness) {
      await harness.tunnel.close()
      await harness.gateway.close()
      await harness.server.close()
      harness.engine.dispose()
    }
    harness = undefined
    for (const db of dbs.splice(0)) {
      if (db.isOpen) db.close()
    }
  })

  // Pair (optionally with a MITM), confirm, then stand up a fake gateway carrying the resulting phone
  // peer over a tunnel whose deviceSessions IS the persistent provider the confirm wrote into.
  const bootPaired = async (opts: {
    tamper: boolean
  }): Promise<{ h: Harness; ceremony: ReturnType<typeof createPairingCeremony> }> => {
    const server = await startTestServer()
    const port = Number(new URL(server.baseUrl).port)

    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    dbs.push(db)
    const store = createRemoteDeviceStore(db)
    const provider = createPersistentDeviceSessionProvider(store)
    const audit = createRemoteAuditStore(db)
    const engine = createRemotePairing({
      deviceStore: store,
      audit,
      getGatewayUrl: () => 'https://gw.example',
      getDaemonId: () => DAEMON_ID,
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => {},
    })

    // Run the simulated pairing ceremony. The phone derives over the daemon's transmitted pubkey; with
    // tamper:true the relayed pubkey is byte-flipped so the phone's keys diverge from the daemon's.
    const ceremony = createPairingCeremony({ engine, provider, tamper: opts.tamper })
    // The human confirms at the desktop (trust root). NOW the persistent provider serves the device.
    const rec = engine.confirmPairing(ceremony.ticket.pairingId)
    if (!rec) throw new Error('confirm failed')

    const gateway = await startFakeGateway({ expectedToken: TOKEN, device: ceremony.device })

    const config: RemoteConfigSource = {
      isEnabled: () => true,
      getGatewayUrl: () => gateway.url,
      getDaemonToken: () => TOKEN,
      getDaemonId: () => DAEMON_ID,
    }
    const tunnel = createRemoteTunnel({
      loopbackPort: port,
      config,
      deviceSessions: provider,
      loopbackSecret: server.store.getRemoteTunnelSecret(),
      audit,
      onStatus: () => {},
    })
    tunnel.refresh()
    await waitFor(() => tunnel.status() === 'online', 4000, 'tunnel online')

    const h: Harness = { server, gateway, tunnel, engine, provider, store, audit }
    harness = h
    return { h, ceremony }
  }

  it('a confirmed phone resolves through the PERSISTENT provider and relays a real /api request', async () => {
    const { h, ceremony } = await bootPaired({ tamper: false })

    // The confirm wrote the device into the persistent store; the provider serves it live.
    expect(h.provider.get(ceremony.deviceId)).not.toBeNull()
    expect(h.store.list(true).map((d) => d.id)).toEqual([ceremony.deviceId])

    // The phone seals a frame with the key it derived; the daemon trial-opens it against the stored
    // p2d candidate. They match (no MITM) -> the request bridges to the live runtime -> 200.
    const res = await h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' })
    expect(res.status).toBe(200)

    await h.audit.flush()
    const httpRow = h.audit
      .list()
      .find((r) => r.action === 'http' && r.endpoint === '/api/workspaces')
    expect(httpRow?.result).toBe('ok')
    expect(httpRow?.deviceId).toBe(ceremony.deviceId)
    // The confirm itself was audited as a session_open for this device.
    expect(
      h.audit.list().some((r) => r.action === 'session_open' && r.deviceId === ceremony.deviceId)
    ).toBe(true)
  })

  it('a MITM during pairing diverges the keys so the confirmed phone cannot open ANY relay stream', async () => {
    const { h, ceremony } = await bootPaired({ tamper: true })

    // The SAS the desktop saw and the SAS the phone derived diverge — the human would refuse here. We
    // force a confirm anyway to prove the SECOND line of defence: divergent keys can't open a frame.
    expect(ceremony.pending?.sas).not.toBe(ceremony.device.sessionKeys.sas)

    // The device row exists (we wrongly confirmed), and the stored p2d (derived against the REAL phone
    // pubkey) differs from the key the tampered phone seals with.
    const stored = h.provider.get(ceremony.deviceId)
    expect(stored).not.toBeNull()
    expect(stored?.keys.p2d).not.toEqual(ceremony.device.sessionKeys.p2d)

    // openHttp seals with the tampered phone's p2d; the daemon's trial-open against the stored p2d
    // candidate fails AEAD. The daemon CANNOT send a Reset for an unresolved first frame (it has no
    // resolved sealer for this device), so the phone just gets silence — the open promise never
    // settles. That silence IS the defence: we fire it and never await it, then assert the drop.
    void h.gateway.openHttp({ method: 'GET', path: '/api/workspaces' }).catch(() => {})

    await waitFor(
      () => {
        h.audit.list()
        return h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
      },
      3000,
      'open_failed reject row'
    )
    await h.audit.flush()
    expect(
      h.audit.list().some((r) => r.action === 'reject' && r.rejectReason === 'open_failed')
    ).toBe(true)
    // The tampered phone never reached the runtime: no http row for it.
    expect(h.audit.list().some((r) => r.action === 'http')).toBe(false)
  })
})
