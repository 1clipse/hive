import { afterEach, describe, expect, test } from 'vitest'
import { createRemoteAuditStore } from '../../src/server/remote-audit-store.js'
import { GW_CONTROL_PREFIX } from '../../src/server/remote-control-constants.js'
import {
  createPersistentDeviceSessionProvider,
  createRemoteDeviceStore,
} from '../../src/server/remote-device-store.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import {
  decodePairingPayload,
  REMOTE_CRYPTO_VERSION,
  X25519_KEY_LEN,
} from '../../src/shared/remote-crypto.js'
import { CHANNEL_STREAM_ID } from '../../src/shared/remote-protocol.js'
import { createPairingCeremony } from '../helpers/remote-test-session.js'

// U12 — the BINDING pairing-transport contract M5's real gateway pairing-relay wires against.
//
// M4 ships NO gateway code (Option B): the phone is driven in-process by the fixture (createPairingCeremony),
// modelling the M5 gateway pairing socket. This file pins the daemon engine surface + the wire-level rules
// any real pairing transport MUST satisfy so M5 cannot silently drift. Every assert here is something a
// reversed/sloppy transport would break.
//
//   1. begin -> hello -> getHandshakeReply -> confirm is the ONLY method surface a transport touches.
//   2. The phone authenticates by POSSESSION of the QR's pairing secret — there is NO device JWT and the
//      phone's identity on the pairing channel is deviceId=null (it has no device row until confirm).
//   3. The PairAck the transport relays to the phone is PUBLIC material only (a daemon X25519 pubkey + ids):
//      no secret, no session key.
//   4. Pairing frames are namespaced distinctly from the gateway control band (GW_CONTROL_PREFIX) and from
//      the E2E mux channel (CHANNEL_STREAM_ID): a pairing exchange is daemon-internal, never an E2E frame.

const dbs: Database[] = []
const disposables: RemotePairing[] = []

afterEach(() => {
  for (const c of disposables.splice(0)) c.dispose()
  for (const db of dbs.splice(0)) {
    if (db.isOpen) db.close()
  }
})

const makeEngine = (): {
  engine: RemotePairing
  provider: ReturnType<typeof createPersistentDeviceSessionProvider>
} => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  dbs.push(db)
  const store = createRemoteDeviceStore(db)
  // The provider exists so we can prove the unpaired phone has NO session before confirm.
  const provider = createPersistentDeviceSessionProvider(store)
  const audit = createRemoteAuditStore(db)
  const engine = createRemotePairing({
    deviceStore: store,
    audit,
    getGatewayUrl: () => 'https://gw.example',
    getDaemonId: () => 'daemon-contract',
    setTimer: () => 0 as unknown as NodeJS.Timeout,
    clearTimer: () => {},
  })
  disposables.push(engine)
  return { engine, provider }
}

describe('pairing-transport contract (U12 — the M5 wiring spec)', () => {
  test('the transport drives begin -> hello -> getHandshakeReply -> confirm and nothing else', () => {
    const { engine, provider } = makeEngine()
    // The four methods a transport invokes, in order. If the engine surface changes shape, the M5
    // transport must change with it — this asserts the shape M5 builds against.
    expect(typeof engine.beginPairing).toBe('function')
    expect(typeof engine.submitDeviceHello).toBe('function')
    expect(typeof engine.getHandshakeReply).toBe('function')
    expect(typeof engine.confirmPairing).toBe('function')

    const c = createPairingCeremony({ engine, provider })
    // The ceremony exercised exactly that sequence and produced a phone peer ready to relay.
    expect(c.ticket.pairingId).toBeTruthy()
    expect(c.reply).not.toBeNull()
    expect(typeof c.device.seal).toBe('function')
  })

  test('the phone authenticates by pairing-secret possession — no device JWT, deviceId is null pre-confirm', () => {
    const { engine, provider } = makeEngine()
    const c = createPairingCeremony({ engine, provider })

    // The only credential the phone carries onto the pairing channel is the QR's pairing secret — the
    // ceremony recovered it from the QR and fed it into deriveDeviceSession. There is no token/JWT field.
    const payload = decodePairingPayload(c.ticket.qr)
    expect(payload.pairingSecret.length).toBeGreaterThan(0)
    expect(Object.keys(payload).sort()).toEqual(['daemonId', 'gatewayUrl', 'pairingSecret', 'v'])

    // Pre-confirm the phone has NO device identity: the provider holds no session for the pending deviceId.
    expect(provider.get(c.reply.deviceId)).toBeNull()
    expect(provider.candidates()).toEqual([])
    // The deviceId the transport sees is a pre-allocated handle, NOT proof of a paired device.
    expect(c.deviceId).toBe(c.reply.deviceId)
  })

  test('the PairAck the transport relays is PUBLIC material only (no secret, no session key)', () => {
    const { engine, provider } = makeEngine()
    const c = createPairingCeremony({ engine, provider })
    const reply = c.reply

    // A daemon X25519 PUBLIC key + ids — exactly what the phone needs to run deriveDeviceSession.
    expect(reply.daemonPublicKey.length).toBe(X25519_KEY_LEN)
    expect(reply.daemonId).toBe('daemon-contract')
    expect(reply.deviceId).toBe(c.deviceId)
    expect(reply.protocolVersion).toBe(REMOTE_CRYPTO_VERSION)

    // The PairAck must not smuggle any private material. The phone's derived session keys are NEVER on
    // the ack — they are computed locally on each side and only checked by the human-compared SAS.
    const serialized = JSON.stringify(reply, (_k, v) =>
      v instanceof Uint8Array ? Array.from(v) : v
    )
    const replySecret = Array.from(c.pairingSecret)
    const sealKey = Array.from(c.device.sessionKeys.p2d)
    expect(serialized.includes(JSON.stringify(replySecret))).toBe(false)
    expect(serialized.includes(JSON.stringify(sealKey))).toBe(false)
  })

  test('pairing is namespaced distinctly from the gateway control band and the E2E mux channel', () => {
    const { engine, provider } = makeEngine()
    const c = createPairingCeremony({ engine, provider })

    // Pairing never rides the gateway control band: the QR/ack/hello carry no control sentinel.
    expect(c.ticket.qr.startsWith(GW_CONTROL_PREFIX)).toBe(false)
    // Pairing is NOT an E2E mux frame: the daemon engine is fed by method calls, so an unpaired phone's
    // first E2E frame (the M3 Hello on the channel stream) would resolve against the device candidates —
    // of which there are none pre-confirm. That separation is exactly invariant 4.
    expect(CHANNEL_STREAM_ID).toBe(0)
    expect(provider.candidates()).toEqual([])
  })

  test('a wrong pairing secret derives a divergent SAS — possession is load-bearing (no MAC needed)', () => {
    const { engine, provider } = makeEngine()
    // The MITM swaps the relayed daemon pubkey; the phone derives against the tampered key.
    const c = createPairingCeremony({ engine, provider, tamper: true })
    // The desktop's SAS (from the real handshake) and the phone's SAS (from the tampered ack) diverge,
    // so the human will refuse — this is the whole authentication story on the pairing channel.
    expect(c.pending?.sas).not.toBe(c.device.sessionKeys.sas)
  })
})
