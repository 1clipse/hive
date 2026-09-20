import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteDeviceStore } from '../../src/server/remote-device-store.js'
import type { PostPairConfirmDeps } from '../../src/server/remote-gateway-client.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import {
  createRemotePairingTunnel,
  type PairConfirmArgs,
  type PairingOutboundFrame,
  type RemotePairingTunnel,
} from '../../src/server/remote-pairing-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  decodePairingPayload,
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'

// Driver-level tests for the pairing-over-tunnel glue (plan steps 2+4, D1/D2/D3). The pairing ENGINE
// is the REAL createRemotePairing over a REAL device store + audit on an in-memory sqlite — no engine
// mock, no crypto mock, no PTY. We drive a real phone hello (real X25519 key + salt) and assert the
// daemon's pair-ack carries the engine's actual daemonPublicKey/ids, and that confirm() registers the
// gateway row BEFORE the local trust-root write (postPairConfirm -> engine insert -> `confirmed`) so a
// failed POST never orphans a local device or burns the pairing code.

const DAEMON_ID = 'daemon-pairing-tunnel'
const GATEWAY_URL = 'https://gw.example'
const DAEMON_TOKEN = 'hd_daemon_token'

describe('remote pairing tunnel driver', () => {
  let db: InstanceType<typeof Database>
  let engine: RemotePairing
  // What the driver emitted over the tunnel (in order).
  let sent: PairingOutboundFrame[]
  // postPairConfirm seam: record every call + let a test make it throw.
  let confirmCalls: Array<{ deps: PostPairConfirmDeps; body: PairConfirmArgs }>
  let confirmShouldThrow: boolean
  // A log to assert the D3 ordering (engine insert vs gateway POST vs `confirmed`).
  let ordering: string[]

  const buildDriver = (): RemotePairingTunnel =>
    createRemotePairingTunnel({
      pairing: engine,
      send: (frame) => {
        if (frame.t === 'confirmed') ordering.push('confirmed')
        sent.push(frame)
      },
      postPairConfirm: async (deps, body) => {
        ordering.push('postPairConfirm')
        confirmCalls.push({ deps, body })
        if (confirmShouldThrow) throw new Error('gateway 401')
      },
      getGatewayUrl: () => GATEWAY_URL,
      getDaemonToken: () => DAEMON_TOKEN,
    })

  // Begin a real pairing on the engine (awaiting_handshake), returning the QR so we can read back the
  // pairing secret the phone would scan. The driver finds the pairing via findAwaitingHandshake().
  const beginPairing = () => engine.beginPairing()

  // Build a real phone hello frame (real device keypair + session salt). The pairing secret is taken
  // from the QR so the engine derives a matching SAS (not asserted here — that's the SAS test's job).
  const helloFrame = (qr: string, proposedName?: string): string => {
    const kp = generateDeviceKeyPair()
    const salt = generateSessionSalt()
    // (the secret is needed by the phone to derive its own session keys; the engine reads it from the
    // pending pairing, not from the hello — so the hello carries only the public key + salt)
    void decodePairingPayload(qr)
    return JSON.stringify({
      t: 'hello',
      devicePublicKey: toBase64Url(kp.publicKey),
      sessionSalt: toBase64Url(salt),
      ...(proposedName !== undefined ? { proposedName } : {}),
    })
  }

  beforeEach(() => {
    db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const deviceStore = createRemoteDeviceStore(db)
    const audit = createRemoteAuditStore(db)
    engine = createRemotePairing({
      deviceStore,
      audit,
      getGatewayUrl: () => GATEWAY_URL,
      getDaemonId: () => DAEMON_ID,
      // No real timers in unit tests.
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => {},
    })
    sent = []
    confirmCalls = []
    confirmShouldThrow = false
    ordering = []
  })

  afterEach(() => {
    engine.dispose()
    if (db.isOpen) db.close()
  })

  it('maps a hello to the awaiting_handshake pairing and replies with the engine pair-ack', () => {
    const driver = buildDriver()
    const ticket = beginPairing()
    driver.onPeerOnline('jti-123')

    driver.onPairingFrame(helloFrame(ticket.qr, 'Pixel 9'))

    expect(sent).toHaveLength(1)
    const ack = sent[0]
    expect(ack?.t).toBe('pair-ack')
    if (ack?.t !== 'pair-ack') throw new Error('expected pair-ack')

    // The ids must be the engine's real values (a hand-coded constant would not match a fresh engine).
    expect(ack.daemonId).toBe(DAEMON_ID)
    // The deviceId is the engine's pre-allocated handle — the pending pairing's deviceId, not invented
    // by the driver. We can't read it directly, but the confirm path below proves the driver tracks it.
    expect(ack.deviceId).toBeTruthy()
    expect(ack.protocolVersion).toBe(2)

    // daemonPublicKey is the ENGINE's public key for this pairing — a real 32-byte X25519 key. The
    // driver base64url-encodes whatever getHandshakeReply returned; assert it round-trips to 32 bytes
    // (an empty / wrong-encoded field would fail length, catching a reversed toBase64Url call).
    expect(fromBase64Url(ack.daemonPublicKey)).toHaveLength(32)
  })

  it('rejects a hello when no awaiting_handshake pairing exists', () => {
    const driver = buildDriver()
    driver.onPeerOnline('jti-123')
    // No beginPairing() — nothing to map onto.
    driver.onPairingFrame(
      JSON.stringify({
        t: 'hello',
        devicePublicKey: toBase64Url(generateDeviceKeyPair().publicKey),
        sessionSalt: toBase64Url(generateSessionSalt()),
      })
    )
    expect(sent).toEqual([{ t: 'rejected', reason: 'expired' }])
  })

  it('keeps malformed hello frames silent (no oracle)', () => {
    const driver = buildDriver()
    beginPairing()
    driver.onPeerOnline('jti-123')

    driver.onPairingFrame(
      JSON.stringify({
        t: 'hello',
        devicePublicKey: toBase64Url(new Uint8Array([1, 2, 3])),
        sessionSalt: toBase64Url(generateSessionSalt()),
      })
    )

    expect(sent).toHaveLength(0)
  })

  it('ignores a non-hello / junk text frame (no pair-ack)', () => {
    const driver = buildDriver()
    beginPairing()
    driver.onPeerOnline('jti-123')
    driver.onPairingFrame('not json at all')
    driver.onPairingFrame(JSON.stringify({ t: 'something-else' }))
    expect(sent).toHaveLength(0)
  })

  it('confirm runs postPairConfirm -> engine-insert -> confirmed, IN THAT ORDER, with the bound jti', async () => {
    const driver = buildDriver()
    const ticket = beginPairing()
    driver.onPeerOnline('jti-abc')
    driver.onPairingFrame(helloFrame(ticket.qr, 'Pixel 9'))
    const ack = sent[0]
    if (ack?.t !== 'pair-ack') throw new Error('expected pair-ack')

    const record = await driver.confirm(ticket.pairingId)
    expect(record).not.toBeNull()

    // The gateway POST happened with the captured boundJti + the device's id + a base64url devicePubkey.
    expect(confirmCalls).toHaveLength(1)
    const call = confirmCalls[0]
    expect(call?.deps).toEqual({ gatewayUrl: GATEWAY_URL, daemonToken: DAEMON_TOKEN })
    expect(call?.body.boundJti).toBe('jti-abc')
    expect(call?.body.deviceId).toBe(record?.id)
    expect(call?.body.deviceId).toBe(ack.deviceId)
    expect(call?.body.name).toBe(record?.name)
    // devicePubkey is the phone's key, base64url — must round-trip to 32 bytes.
    expect(fromBase64Url(call?.body.devicePubkey ?? '')).toHaveLength(32)

    // The `confirmed` frame went out AND only AFTER the gateway POST (D3 ordering — the gateway row
    // must exist before the phone is told OK, so its /pair/session can't 403).
    const confirmed = sent.at(-1)
    expect(confirmed?.t).toBe('confirmed')
    if (confirmed?.t === 'confirmed') expect(confirmed.deviceId).toBe(record?.id)
    expect(ordering).toEqual(['postPairConfirm', 'confirmed'])
  })

  it('AWAITS /pair/confirm to completion before sending confirmed (not fire-and-forget — D3 race safety)', async () => {
    // The ordering test above can't tell `await postPairConfirm(); send()` from a fire-and-forget
    // `postPairConfirm(); send()` (the mock records synchronously). This pins it: with a gateway POST
    // that stays PENDING, `confirmed` must NOT go out until it RESOLVES. A dropped await would send
    // `confirmed` on the same tick — failing the mid-flight assertion — which is the D3 race the phone's
    // /pair/session depends on (the gateway device row must exist before the phone is told OK).
    let resolveGateway: () => void = () => {}
    const gatewayDone = new Promise<void>((r) => {
      resolveGateway = r
    })
    const driver = createRemotePairingTunnel({
      pairing: engine,
      send: (frame) => {
        if (frame.t === 'confirmed') ordering.push('confirmed')
        sent.push(frame)
      },
      postPairConfirm: async () => {
        ordering.push('post:start')
        await gatewayDone
        ordering.push('post:done')
      },
      getGatewayUrl: () => GATEWAY_URL,
      getDaemonToken: () => DAEMON_TOKEN,
    })
    const ticket = beginPairing()
    driver.onPeerOnline('jti-abc')
    driver.onPairingFrame(helloFrame(ticket.qr))

    // Start confirm but DO NOT await — the gateway POST is in flight (unresolved).
    const pending = driver.confirm(ticket.pairingId)
    await Promise.resolve()
    await Promise.resolve()
    // While the POST is pending, the phone must NOT have been told confirmed.
    expect(sent.some((f) => f.t === 'confirmed')).toBe(false)

    // Let the gateway POST resolve; only NOW may confirmed go out.
    resolveGateway()
    await pending
    expect(sent.some((f) => f.t === 'confirmed')).toBe(true)
    expect(ordering).toEqual(['post:start', 'post:done', 'confirmed'])
  })

  it('a failed gateway POST writes NOTHING local + leaves the pairing confirmable (atomic confirm)', async () => {
    const driver = buildDriver()
    const ticket = beginPairing()
    driver.onPeerOnline('jti-abc')
    driver.onPairingFrame(helloFrame(ticket.qr))

    confirmShouldThrow = true
    await expect(driver.confirm(ticket.pairingId)).rejects.toThrow()

    // Atomicity: the gateway POST was attempted, but because it failed the local trust-root write never
    // ran. The pairing is STILL awaiting_confirm (no ghost device, the code is reusable) and the phone
    // was never told confirmed. The OLD order wrote the device + consumed the pending FIRST, so this
    // assertion (pairing still confirmable after a failed POST) fails on the pre-fix code.
    expect(confirmCalls).toHaveLength(1)
    expect(sent.some((f) => f.t === 'confirmed')).toBe(false)
    expect(ordering).toEqual(['postPairConfirm']) // never reached `confirmed`
    expect(engine.getPending(ticket.pairingId)).not.toBeNull() // NOT consumed → retryable

    // The desktop retries once the gateway recovers — and it works, proving the code wasn't burned.
    confirmShouldThrow = false
    const record = await driver.confirm(ticket.pairingId)
    expect(record).not.toBeNull()
    expect(sent.some((f) => f.t === 'confirmed')).toBe(true)
    expect(engine.getPending(ticket.pairingId)).toBeNull() // now consumed
  })

  it('does NOT post or confirm when boundJti is missing (no peer-online jti)', async () => {
    const driver = buildDriver()
    const ticket = beginPairing()
    // peer-online arrived WITHOUT a jti (or never carried one) — D3 guard must refuse.
    driver.onPeerOnline(undefined)
    driver.onPairingFrame(helloFrame(ticket.qr))

    await expect(driver.confirm(ticket.pairingId)).rejects.toThrow(/boundJti/)
    expect(confirmCalls).toHaveLength(0)
    expect(sent.some((f) => f.t === 'confirmed')).toBe(false)
  })

  it('a NEW peer-online resets the active pairing — a stale handshake is no longer confirmable (D1)', async () => {
    const driver = buildDriver()
    const ticket = beginPairing()
    driver.onPeerOnline('jti-first')
    driver.onPairingFrame(helloFrame(ticket.qr))
    expect(sent[0]?.t).toBe('pair-ack') // first handshake completed

    // A second phone races the daemon: the relay replaced the pair socket, so a new peer-online fires.
    // This must drop the first pairing's active state — confirming the (now stale) first pairingId must
    // NOT post to the gateway with the first jti (the security risk D1 guards against).
    driver.onPeerOnline('jti-second')

    await expect(driver.confirm(ticket.pairingId)).rejects.toThrow(/boundJti/)
    expect(confirmCalls).toHaveLength(0)
    expect(sent.some((f) => f.t === 'confirmed')).toBe(false)
  })

  it('confirm of an unknown pairing returns null without posting or sending', async () => {
    const driver = buildDriver()
    driver.onPeerOnline('jti-x')
    const record = await driver.confirm('no-such-pairing')
    expect(record).toBeNull()
    expect(confirmCalls).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})
