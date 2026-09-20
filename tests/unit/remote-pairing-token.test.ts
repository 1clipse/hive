import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteDeviceStore } from '../../src/server/remote-device-store.js'
import {
  createRemotePairing,
  type DevicePairingHello,
  PAIRING_TTL_MS,
  type RemotePairing,
  type RemotePairingDeps,
} from '../../src/server/remote-pairing.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'
import {
  normalizePairingCode,
  PAIRING_CODE_SECRET_CONTEXT,
} from '../../src/shared/remote-pairing-code.js'

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

// A controllable clock + a no-op timer seam so TTL is deterministic (no real setTimeout fires).
const makeClock = (start = 1_000_000) => {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const noTimers: Pick<RemotePairingDeps, 'setTimer' | 'clearTimer'> = {
  // Return a dummy handle; the engine must also lazily expire on access so we never rely on
  // the timer firing in unit tests.
  setTimer: () => 0 as unknown as NodeJS.Timeout,
  clearTimer: () => {},
}

const makeEngine = (overrides: Partial<RemotePairingDeps> = {}): { engine: RemotePairing } => {
  const db = openDb()
  const engine = createRemotePairing({
    deviceStore: createRemoteDeviceStore(db),
    audit: createRemoteAuditStore(db),
    getGatewayUrl: () => 'https://gw.example',
    getDaemonId: () => 'daemon-abc',
    ...noTimers,
    ...overrides,
  })
  disposables.push(engine)
  return { engine }
}

// A real phone-side hello: a genuine X25519 keypair + a fresh salt, exactly like the device would send.
const phoneHello = (pairingId: string, proposedName?: string): DevicePairingHello => {
  const kp = generateDeviceKeyPair()
  return {
    pairingId,
    devicePublicKey: kp.publicKey,
    sessionSalt: generateSessionSalt(),
    ...(proposedName === undefined ? {} : { proposedName }),
  }
}

describe('remote-pairing token: short TTL + one-time (invariant 2)', () => {
  test('beginPairing mints a fresh pairing code whose derived 32-byte secret is embedded in the compatibility QR', () => {
    const clock = makeClock()
    const { engine } = makeEngine({ now: clock.now })

    const a = engine.beginPairing()
    const b = engine.beginPairing()

    expect(a.pairingId).not.toBe(b.pairingId)
    expect(a.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(b.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(a.code).not.toBe(b.code)

    const payloadA = JSON.parse(a.qr) as { pairingSecret: string }
    const payloadB = JSON.parse(b.qr) as { pairingSecret: string }
    // 32-byte secret -> 43 base64url chars (no padding). A constant/empty secret would fail here.
    expect(fromBase64Url(payloadA.pairingSecret).length).toBe(PAIRING_SECRET_LEN)
    expect(fromBase64Url(payloadB.pairingSecret).length).toBe(PAIRING_SECRET_LEN)
    expect(payloadA.pairingSecret).not.toBe(payloadB.pairingSecret)

    const normalizedA = normalizePairingCode(a.code)
    expect(normalizedA).not.toBeNull()
    const derivedA = new Uint8Array(
      createHash('sha256')
        .update(PAIRING_CODE_SECRET_CONTEXT)
        .update(normalizedA ?? '')
        .digest()
    )
    expect(payloadA.pairingSecret).toBe(toBase64Url(derivedA))
  })

  test('TTL is short and recorded on the ticket', () => {
    const clock = makeClock(5_000)
    const { engine } = makeEngine({ now: clock.now })

    const ticket = engine.beginPairing()
    // Product decision: five minutes gives real phone/OAuth/manual-scan paths room while staying at the
    // audited safety ceiling for a leaked one-time QR.
    expect(PAIRING_TTL_MS).toBe(5 * 60_000)
    expect(PAIRING_TTL_MS).toBeLessThanOrEqual(5 * 60_000)
    expect(ticket.expiresAt).toBe(5_000 + PAIRING_TTL_MS)
  })

  test('a second hello on the same pairingId is refused — one-time consumption', () => {
    const clock = makeClock()
    const { engine } = makeEngine({ now: clock.now })
    const { pairingId } = engine.beginPairing()

    const first = engine.submitDeviceHello(phoneHello(pairingId))
    expect(first).not.toBeNull()

    // Replay: the token was already moved out of awaiting_handshake. If the guard is missing this
    // returns a fresh pending view and a second pairing could be confirmed.
    const replay = engine.submitDeviceHello(phoneHello(pairingId))
    expect(replay).toBeNull()
  })

  test('a hello after the TTL has elapsed is refused — expiry', () => {
    const clock = makeClock()
    const { engine } = makeEngine({ now: clock.now })
    const { pairingId } = engine.beginPairing()

    clock.advance(PAIRING_TTL_MS + 1)

    const result = engine.submitDeviceHello(phoneHello(pairingId))
    expect(result).toBeNull()
    // and there is no pending entry left to confirm
    expect(engine.getPending(pairingId)).toBeNull()
  })

  test('a hello for an unknown pairingId is refused', () => {
    const { engine } = makeEngine()
    expect(engine.submitDeviceHello(phoneHello('never-minted'))).toBeNull()
  })

  test('replay / expiry / unknown each write a reject audit row with a concrete reason', () => {
    const clock = makeClock()
    const db = openDb()
    const audit = createRemoteAuditStore(db)
    const engine = createRemotePairing({
      deviceStore: createRemoteDeviceStore(db),
      audit,
      getGatewayUrl: () => 'https://gw.example',
      getDaemonId: () => 'daemon-abc',
      now: clock.now,
      ...noTimers,
    })
    disposables.push(engine)

    // unknown
    engine.submitDeviceHello(phoneHello('bogus'))
    // replay
    const { pairingId } = engine.beginPairing()
    engine.submitDeviceHello(phoneHello(pairingId))
    engine.submitDeviceHello(phoneHello(pairingId))
    // expiry
    const { pairingId: pid2 } = engine.beginPairing()
    clock.advance(PAIRING_TTL_MS + 1)
    engine.submitDeviceHello(phoneHello(pid2))

    const reasons = audit
      .list(50)
      .filter((r) => r.action === 'reject')
      .map((r) => r.rejectReason)
    expect(reasons).toContain('pairing_unknown')
    expect(reasons).toContain('pairing_replay')
    expect(reasons).toContain('pairing_expired')
    // Every reject row must be result:'rejected'.
    for (const row of audit.list(50).filter((r) => r.action === 'reject')) {
      expect(row.result).toBe('rejected')
    }
  })
})

describe('remote-pairing QR: only the M1 PairingPayload fields (invariant 7)', () => {
  test('the QR string carries exactly {v,gatewayUrl,daemonId,pairingSecret} — no key, no token', () => {
    const { engine } = makeEngine()
    const { qr } = engine.beginPairing()

    const parsed = JSON.parse(qr) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['daemonId', 'gatewayUrl', 'pairingSecret', 'v'])
    expect(parsed.v).toBe(REMOTE_CRYPTO_VERSION)
    expect(parsed.gatewayUrl).toBe('https://gw.example')
    expect(parsed.daemonId).toBe('daemon-abc')

    // No session key material, no daemon bearer token, no transcript, no SAS in the QR.
    expect(qr).not.toMatch(/sas/i)
    expect(qr).not.toMatch(/d2p|p2d|sessionKey|transcript|token/i)
  })

  test('beginPairing throws when not logged in (no gatewayUrl / daemonId)', () => {
    const { engine } = makeEngine({ getGatewayUrl: () => null })
    expect(() => engine.beginPairing()).toThrow()

    const { engine: e2 } = makeEngine({ getDaemonId: () => null })
    expect(() => e2.beginPairing()).toThrow()
  })
})
