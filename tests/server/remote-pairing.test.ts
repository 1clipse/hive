import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { DAEMON_OPEN_DIRECTION } from '../../src/server/remote-device-session.js'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
} from '../../src/server/remote-device-store.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  deriveDeviceSession,
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
} from '../../src/shared/remote-crypto.js'

// This file exercises the pending->confirmed/expired state machine against the REAL runtime
// collaborators (a real SQLite-backed device store + the persistent DeviceSessionProvider + the real
// audit store) and a REAL X25519 phone peer that derives its own session from the daemon's transmitted
// public key (Option B in-process simulation; no PTY is involved so the no-PTY-mock rule does not
// apply). The full /relay e2e (S1/S5/S6 over the fake-gateway) is wired in the fixtures/wiring stage —
// see notes; the daemon-side facts every M4 invariant rests on are all provable here.

const dbs: Database[] = []
const disposables: RemotePairing[] = []
const tempFileDirs: string[] = []

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
  for (const dir of tempFileDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const makeClock = (start = 2_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const harness = (now: () => number = Date.now) => {
  const db = openDb()
  const store = createRemoteDeviceStore(db)
  const provider = createPersistentDeviceSessionProvider(store)
  const audit = createRemoteAuditStore(db)
  const engine = createRemotePairing({
    deviceStore: store,
    audit,
    getGatewayUrl: () => 'https://gw.example',
    getDaemonId: () => 'daemon-srv',
    now,
    setTimer: () => 0 as unknown as NodeJS.Timeout,
    clearTimer: () => {},
  })
  disposables.push(engine)
  return { db, store, provider, audit, engine }
}

// The phone half of the ceremony. Real keypair + salt; derives from the daemon's transmitted pubkey.
const phonePairs = (engine: RemotePairing, opts: { tamper?: boolean; name?: string } = {}) => {
  const ticket = engine.beginPairing()
  const secret = fromBase64Url((JSON.parse(ticket.qr) as { pairingSecret: string }).pairingSecret)
  const kp = generateDeviceKeyPair()
  const salt = generateSessionSalt()

  const pending = engine.submitDeviceHello({
    pairingId: ticket.pairingId,
    devicePublicKey: kp.publicKey,
    sessionSalt: salt,
    ...(opts.name === undefined ? {} : { proposedName: opts.name }),
  })
  const reply = engine.getHandshakeReply(ticket.pairingId)
  if (!reply) throw new Error('expected reply')

  const daemonPub = opts.tamper
    ? (() => {
        const s = Uint8Array.from(reply.daemonPublicKey)
        s[0] = (s[0] ?? 0) ^ 0x01
        return s
      })()
    : reply.daemonPublicKey

  const phoneSession = deriveDeviceSession({
    deviceSecretKey: kp.secretKey,
    daemonPublicKey: daemonPub,
    devicePublicKey: kp.publicKey,
    pairingSecret: secret,
    sessionSalt: salt,
    ids: {
      daemonId: reply.daemonId,
      deviceId: reply.deviceId,
      protocolVersion: reply.protocolVersion,
    },
  })

  return { ticket, pending, reply, phoneSession }
}

describe('remote-pairing pending-state against real runtime collaborators', () => {
  // S1-ish (daemon half): the headline trust-root coupling between the engine and the provider.
  test('no usable session pre-confirm; provider returns it only after the human confirms', () => {
    const { engine, provider } = harness()
    const { ticket, pending, reply, phoneSession } = phonePairs(engine)

    // SAS the desktop shows equals the phone's SAS.
    expect(pending?.sas).toBe(phoneSession.sas)

    // PRE-CONFIRM: the device is not in the provider. A relay open would resolve to no session.
    expect(provider.get(reply.deviceId)).toBeNull()
    expect(provider.candidates()).toEqual([])

    // CONFIRM (desktop human).
    const rec = engine.confirmPairing(ticket.pairingId)
    expect(rec?.id).toBe(reply.deviceId)

    // POST-CONFIRM: the provider hands out the device, and the key the daemon OPENS with (p2d) is
    // byte-equal to the key the phone SEALS with. This is what lets the M3 bridge open the phone's
    // frames; a mismatch here would silently break every device-mode stream.
    const session = provider.get(reply.deviceId)
    expect(session).not.toBeNull()
    expect(DAEMON_OPEN_DIRECTION).toBe('p2d')
    expect(session?.keys.p2d).toEqual(phoneSession.p2d)
    expect(session?.keys.d2p).toEqual(phoneSession.d2p)
  })

  // S2-ish: handshake without a confirm yields nothing the provider will serve.
  test('handshake without confirm leaves the provider empty (invariant 1 + 4)', () => {
    const { engine, provider, store } = harness()
    const { reply } = phonePairs(engine)

    expect(provider.get(reply.deviceId)).toBeNull()
    expect(store.list(true)).toEqual([])
  })

  // S5-ish: one-time + expiry against the real store/provider.
  test('replay + expiry never create a second usable device', () => {
    const clock = makeClock()
    const { engine, provider, store } = harness(clock.now)

    // First pairing, confirmed -> one device.
    const first = phonePairs(engine)
    engine.confirmPairing(first.ticket.pairingId)
    expect(store.list(true).length).toBe(1)

    // Replaying the SAME pairingId after consumption is refused.
    expect(
      engine.submitDeviceHello({
        pairingId: first.ticket.pairingId,
        devicePublicKey: generateDeviceKeyPair().publicKey,
        sessionSalt: generateSessionSalt(),
      })
    ).toBeNull()

    // A new ticket left to expire never becomes usable.
    const second = engine.beginPairing()
    clock.advance(10 * 60_000)
    expect(
      engine.submitDeviceHello({
        pairingId: second.pairingId,
        devicePublicKey: generateDeviceKeyPair().publicKey,
        sessionSalt: generateSessionSalt(),
      })
    ).toBeNull()
    expect(engine.confirmPairing(second.pairingId)).toBeNull()

    expect(store.list(true).length).toBe(1)
    expect(provider.candidates().length).toBe(1)
  })

  // S6-ish (daemon half): MITM diverges the SAS; a careless confirm still cannot open phone frames.
  test('MITM key swap diverges SAS and the persisted key cannot decrypt the phone (invariant 3)', () => {
    const { engine, provider } = harness()
    const { ticket, pending, reply, phoneSession } = phonePairs(engine, { tamper: true })

    expect(pending?.sas).not.toBe(phoneSession.sas)

    // Even if the user wrongly confirmed, the daemon's stored p2d (derived against the real phone
    // pubkey) differs from the key the tampered phone seals with -> AEAD open fails on the wire.
    engine.confirmPairing(ticket.pairingId)
    const stored = provider.get(reply.deviceId)
    expect(stored).not.toBeNull()
    expect(stored?.keys.p2d).not.toEqual(phoneSession.p2d)
  })

  // Persistence across a reopened store on the same file (S9 daemon half).
  test('a confirmed device rehydrates the provider from a reopened db', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-pair-srv-'))
    tempFileDirs.push(tmp)
    const file = join(tmp, 'runtime.sqlite')

    const db1 = new Database(file)
    initializeRuntimeDatabase(db1)
    const store1 = createRemoteDeviceStore(db1)
    const audit1 = createRemoteAuditStore(db1)
    const engine1 = createRemotePairing({
      deviceStore: store1,
      audit: audit1,
      getGatewayUrl: () => 'https://gw.example',
      getDaemonId: () => 'daemon-persist',
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => {},
    })
    const { ticket, phoneSession, reply } = phonePairs(engine1)
    engine1.confirmPairing(ticket.pairingId)
    engine1.dispose()
    db1.close()

    const db2 = new Database(file)
    initializeRuntimeDatabase(db2)
    dbs.push(db2)
    const provider2 = createPersistentDeviceSessionProvider(createRemoteDeviceStore(db2))
    const session = provider2.get(reply.deviceId)
    expect(session?.keys.p2d).toEqual(phoneSession.p2d)
  })
})
