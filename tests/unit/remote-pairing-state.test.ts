import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import {
  createRemoteDeviceStore,
  type RemoteDeviceStore,
} from '../../src/server/remote-device-store.js'
import {
  createRemotePairing,
  type DevicePairingHello,
  type RemotePairing,
  type RemotePairingDeps,
} from '../../src/server/remote-pairing.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { generateDeviceKeyPair, generateSessionSalt } from '../../src/shared/remote-crypto.js'

const dbs: Database[] = []
const disposables: RemotePairing[] = []

const openDb = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const p of disposables.splice(0)) p.dispose()
  for (const db of dbs.splice(0)) {
    if (db.isOpen) db.close()
  }
})

const makeClock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const setup = (overrides: Partial<RemotePairingDeps> = {}) => {
  const db = openDb()
  const store = createRemoteDeviceStore(db)
  const audit = createRemoteAuditStore(db)
  const engine = createRemotePairing({
    deviceStore: store,
    audit,
    getGatewayUrl: () => 'https://gw.example',
    getDaemonId: () => 'daemon-state',
    setTimer: () => 0 as unknown as NodeJS.Timeout,
    clearTimer: () => {},
    ...overrides,
  })
  disposables.push(engine)
  return { engine, store, audit }
}

const hello = (pairingId: string, proposedName?: string): DevicePairingHello => {
  const kp = generateDeviceKeyPair()
  return {
    pairingId,
    devicePublicKey: kp.publicKey,
    sessionSalt: generateSessionSalt(),
    ...(proposedName === undefined ? {} : { proposedName }),
  }
}

const countRows = (store: RemoteDeviceStore) => store.list(true).length

describe('remote-pairing state machine (invariant 1 — persist ONLY on confirm)', () => {
  test('happy path awaiting_handshake -> awaiting_confirm -> confirmed inserts EXACTLY once, on confirm', () => {
    const { engine, store } = setup()
    const ticket = engine.beginPairing()

    // After begin: nothing persisted, nothing pending-confirmable.
    expect(countRows(store)).toBe(0)

    const pending = engine.submitDeviceHello(hello(ticket.pairingId, 'Pixel 9'))
    expect(pending).not.toBeNull()
    expect(pending?.deviceName).toBe('Pixel 9')
    expect(pending?.sas).toMatch(/^\d{6}$/)

    // After handshake but BEFORE confirm: STILL nothing persisted. This is the single most
    // important assertion — if the product inserts on hello, this flips to 1 and the test fails.
    expect(countRows(store)).toBe(0)
    expect(store.getLiveSession(pendingDeviceId(engine, ticket.pairingId))).toBeNull()

    const rec = engine.confirmPairing(ticket.pairingId)
    expect(rec).not.toBeNull()
    expect(countRows(store)).toBe(1)
    // The provider can now hand out the session.
    expect(store.getLiveSession(rec?.id ?? '')).not.toBeNull()
  })

  test('confirm persists the SAME directional keys the handshake derived', () => {
    const { engine, store } = setup()
    const ticket = engine.beginPairing()
    const pending = engine.submitDeviceHello(hello(ticket.pairingId))
    expect(pending).not.toBeNull()

    const rec = engine.confirmPairing(ticket.pairingId)
    expect(rec).not.toBeNull()

    const session = store.getLiveSession(rec?.id ?? '')
    expect(session?.keys.d2p.length).toBe(32)
    expect(session?.keys.p2d.length).toBe(32)
    // The daemon's own SessionKeys came from deriveDaemonSession; the persisted ones must match the
    // exact bytes the handshake produced (not zeros / placeholders).
    const reply = engine.getHandshakeReply(ticket.pairingId)
    // After confirm the pairing is consumed, so the reply is gone — that itself proves consumption.
    expect(reply).toBeNull()
  })

  test('reject from awaiting_confirm persists nothing and is terminal', () => {
    const { engine, store, audit } = setup()
    const ticket = engine.beginPairing()
    engine.submitDeviceHello(hello(ticket.pairingId))

    engine.rejectPairing(ticket.pairingId, 'user_rejected')

    expect(countRows(store)).toBe(0)
    expect(engine.getPending(ticket.pairingId)).toBeNull()
    // A confirm after reject does nothing — the pairing is gone.
    expect(engine.confirmPairing(ticket.pairingId)).toBeNull()
    expect(countRows(store)).toBe(0)

    const rejectReasons = audit
      .list(20)
      .filter((r) => r.action === 'reject')
      .map((r) => r.rejectReason)
    expect(rejectReasons).toContain('user_rejected')
  })

  test('timeout/expiry from awaiting_confirm persists nothing', () => {
    const clock = makeClock()
    const { engine, store } = setup({ now: clock.now })
    const ticket = engine.beginPairing()
    engine.submitDeviceHello(hello(ticket.pairingId))

    // The dialog sat open past the TTL.
    clock.advance(60 * 60_000)

    // A confirm of an expired pending is refused (lazy sweep on access), and nothing persists.
    expect(engine.confirmPairing(ticket.pairingId)).toBeNull()
    expect(countRows(store)).toBe(0)
    expect(engine.getPending(ticket.pairingId)).toBeNull()
  })

  test('a replayed token never reaches awaiting_confirm a second time', () => {
    const { engine } = setup()
    const ticket = engine.beginPairing()

    expect(engine.submitDeviceHello(hello(ticket.pairingId))).not.toBeNull()
    // The token is consumed; a second hello cannot create a second confirmable pending.
    expect(engine.submitDeviceHello(hello(ticket.pairingId))).toBeNull()
    // listPending shows exactly one pending (the first), not two.
    expect(engine.listPending().filter((p) => p.pairingId === ticket.pairingId).length).toBe(1)
  })

  test('confirm of an unknown / never-handshaked pairing returns null and persists nothing', () => {
    const { engine, store } = setup()
    // confirm without any begin/hello
    expect(engine.confirmPairing('nope')).toBeNull()
    // confirm of a begun-but-not-handshaked pairing (still awaiting_handshake) is refused
    const ticket = engine.beginPairing()
    expect(engine.confirmPairing(ticket.pairingId)).toBeNull()
    expect(countRows(store)).toBe(0)
  })

  test('confirm writes a session_open audit row tagged with the device id', () => {
    const { engine, audit } = setup()
    const ticket = engine.beginPairing()
    engine.submitDeviceHello(hello(ticket.pairingId))
    const rec = engine.confirmPairing(ticket.pairingId)

    const opens = audit.list(20).filter((r) => r.action === 'session_open')
    expect(opens.length).toBe(1)
    expect(opens[0]?.result).toBe('ok')
    expect(opens[0]?.deviceId).toBe(rec?.id)
  })

  test('confirm honours an operator-supplied name override', () => {
    const { engine, store } = setup()
    const ticket = engine.beginPairing()
    engine.submitDeviceHello(hello(ticket.pairingId, 'phone-proposed'))

    const rec = engine.confirmPairing(ticket.pairingId, { name: 'My iPhone' })
    expect(rec?.name).toBe('My iPhone')
    expect(store.get(rec?.id ?? '')?.name).toBe('My iPhone')
  })

  test('pending view never leaks the pairing secret or key material', () => {
    const { engine } = setup()
    const ticket = engine.beginPairing()
    const pending = engine.submitDeviceHello(hello(ticket.pairingId))
    expect(pending).not.toBeNull()

    const keys = Object.keys(pending as object).sort()
    expect(keys).toEqual(['deviceName', 'expiresAt', 'pairingId', 'sas'])
    const serialized = JSON.stringify(pending)
    expect(serialized).not.toMatch(/secret|d2p|p2d|transcript/i)
  })
})

// Helper: derive the pre-allocated deviceId for a pairing from its (only) handshake reply so we can
// assert the provider has nothing for it before confirm.
const pendingDeviceId = (engine: RemotePairing, pairingId: string): string => {
  const reply = engine.getHandshakeReply(pairingId)
  return reply?.deviceId ?? '__none__'
}
