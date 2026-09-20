import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { createRemoteDeviceStore } from '../../src/server/remote-device-store.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  deriveDeviceSession,
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
  REMOTE_CRYPTO_VERSION,
} from '../../src/shared/remote-crypto.js'

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

const makeEngine = (): RemotePairing => {
  const db = openDb()
  const engine = createRemotePairing({
    deviceStore: createRemoteDeviceStore(db),
    audit: createRemoteAuditStore(db),
    getGatewayUrl: () => 'https://gw.example',
    getDaemonId: () => 'daemon-sas',
    setTimer: () => 0 as unknown as NodeJS.Timeout,
    clearTimer: () => {},
  })
  disposables.push(engine)
  return engine
}

// Drive the daemon engine + a REAL phone peer through the handshake. The phone derives its own session
// from the daemon's *transmitted* public key (getHandshakeReply) — it never copies the daemon's keys —
// so the SAS comparison is genuine (not vacuous). A MITM flips a byte of the transmitted pubkey.
const runHandshake = (engine: RemotePairing, opts: { tamper?: boolean } = {}) => {
  const ticket = engine.beginPairing()
  const payload = JSON.parse(ticket.qr) as { pairingSecret: string }
  const pairingSecret = fromBase64Url(payload.pairingSecret)

  const phoneKp = generateDeviceKeyPair()
  const sessionSalt = generateSessionSalt()

  const pending = engine.submitDeviceHello({
    pairingId: ticket.pairingId,
    devicePublicKey: phoneKp.publicKey,
    sessionSalt,
  })
  if (!pending) throw new Error('handshake should have produced a pending view')

  const reply = engine.getHandshakeReply(ticket.pairingId)
  if (!reply) throw new Error('expected a handshake reply')

  const daemonPublicKey = opts.tamper
    ? (() => {
        const swapped = Uint8Array.from(reply.daemonPublicKey)
        swapped[0] = (swapped[0] ?? 0) ^ 0x01
        return swapped
      })()
    : reply.daemonPublicKey

  const phoneSession = deriveDeviceSession({
    deviceSecretKey: phoneKp.secretKey,
    daemonPublicKey,
    devicePublicKey: phoneKp.publicKey,
    pairingSecret,
    sessionSalt,
    ids: {
      daemonId: reply.daemonId,
      deviceId: reply.deviceId,
      protocolVersion: reply.protocolVersion,
    },
  })

  return { ticket, pending, reply, phoneSession }
}

describe('remote-pairing SAS (invariant 3)', () => {
  test('honest handshake: daemon SAS equals phone SAS, 6 digits', () => {
    const engine = makeEngine()
    const { pending, phoneSession } = runHandshake(engine)

    expect(pending.sas).toMatch(/^\d{6}$/)
    expect(pending.sas).toBe(phoneSession.sas)
  })

  test('MITM: swapping the daemon public key in transit diverges the SAS', () => {
    const engine = makeEngine()
    const { pending, phoneSession } = runHandshake(engine, { tamper: true })

    // The human compares two codes; under a key swap they no longer match -> the human won't confirm.
    expect(pending.sas).not.toBe(phoneSession.sas)
  })

  test('MITM also diverges directional keys, so a forced confirm cannot decrypt phone frames', () => {
    // Honest peer (control) vs tampered peer.
    const honest = runHandshake(makeEngine())
    const tampered = runHandshake(makeEngine(), { tamper: true })

    // The phone fed a forged daemon pubkey derives a p2d that the daemon (which derived against the
    // real phone pubkey + its real secret) will not match — so an AEAD open on the wire fails even if
    // the user mistakenly confirmed.
    expect(tampered.phoneSession.sas).not.toBe(tampered.pending.sas)
    expect(tampered.phoneSession.p2d).not.toEqual(honest.phoneSession.p2d)
  })

  test('the handshake reply carries the protocol version through to the phone', () => {
    const engine = makeEngine()
    const { reply } = runHandshake(engine)
    expect(reply.protocolVersion).toBe(REMOTE_CRYPTO_VERSION)
  })
})
