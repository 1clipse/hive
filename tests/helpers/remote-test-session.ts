import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'

import type { DeviceSessionProvider } from '../../src/server/remote-device-session.js'
import {
  type DeviceSession,
  InMemoryDeviceSessionProvider,
} from '../../src/server/remote-device-session.js'
import type {
  HandshakeReply,
  PendingPairingView,
  RemotePairing,
} from '../../src/server/remote-pairing.js'
import {
  type ConnectionKeys,
  createOpener,
  createSealer,
  decodePairingPayload,
  deriveConnectionKeys,
  deriveDaemonSession,
  deriveDeviceSession,
  type FrameOpener,
  type FrameSealer,
  fromBase64Url,
  generateConnSalt,
  generateDeviceKeyPair,
  generateSessionSalt,
  type HandshakeIds,
  openNext,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  type SessionKeys,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  createStreamIdAllocator,
  decodeConnSalt,
  encodeConnSalt,
  encodeHeader,
  encodeHello,
  FrameKind as FK,
  type FrameKind,
  isConnSaltPayload,
  type StreamMeta,
} from '../../src/shared/remote-protocol.js'
import { tamperDaemonPublicKey } from './fake-gateway.js'

// The DEVICE (phone) half of the M1 session, paired against a matching daemon-side DeviceSession.
// This is NOT a mock of the crypto: it runs the real deriveDeviceSession / sealNext / openNext over
// real ECDH inputs, so the fake gateway can act as a genuine phone peer end-to-end. The daemon side
// is seeded into an InMemoryDeviceSessionProvider that the tunnel's bridge consumes.
//
// On-wire E2E frame = encodeHeader(12 bytes) || ciphertext. The device seals outbound (phone->daemon)
// with p2d and opens inbound (daemon->phone) with d2p — the mirror of the daemon's directions.

export interface DevicePeer {
  readonly deviceId: string
  /** Allocate the next odd (device-side) stream id. */
  nextStreamId(): number
  /**
   * Begin a connection (M6.1): draw a fresh phoneConnSalt, drop the prior connKeys/sealer/opener,
   * restart the stream-id allocator, and return the UNSEALED ConnSalt{device} frame the caller sends
   * on CONN_SALT_STREAM_ID. The sealed Hello is deferred until the daemon's ConnSalt arrives (see
   * open()). A fresh DevicePeer is created per page-load; beginChannel models a (re)connect over it.
   */
  beginChannel(): Uint8Array
  /** Seal a frame on a stream the device is the sender of (phone->daemon, under the connKey p2d). */
  seal(args: { kind: FrameKind; streamId: number; flags?: number; payload: Uint8Array }): Uint8Array
  /** Build the sealed binding Hello on CHANNEL_STREAM_ID (under the connKey). */
  sealHello(): Uint8Array
  /**
   * Feed an inbound daemon->phone frame. The daemon's UNSEALED ConnSalt{daemon} (on
   * CONN_SALT_STREAM_ID) is consumed here: it derives the per-connection AEAD keys and arms the
   * sealer/opener; the caller gets back { connSalt: true } and should then send sealHello() + any
   * deferred traffic. Any other frame is opened under the connKey and returned as
   * { header, plaintext }. Throws if a sealed frame arrives before the connKeys are armed.
   */
  open(
    frame: Uint8Array
  ):
    | { connSalt: true }
    | { connSalt?: false; header: ReturnType<typeof decodeHeaderLite>; plaintext: Uint8Array }
  /** True once the daemon's ConnSalt arrived and the connKeys are armed (the phone can seal). */
  armed(): boolean
}

/** Observation hook: fires for every phone->daemon seal with the REAL connKey + REAL header. */
export type DeviceSealObserver = (rec: { key: Uint8Array; headerBytes: Uint8Array }) => void

// Local 12-byte header decode for the device peer (the device opens with d2p; openNext needs seq).
function decodeHeaderLite(headerBytes: Uint8Array) {
  const dv = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength)
  return {
    version: dv.getUint8(0),
    kind: dv.getUint8(1) as FrameKind,
    flags: dv.getUint16(2),
    streamId: dv.getUint32(4),
    seq: dv.getUint32(8),
  }
}

const HEADER_BYTES = 12

export interface TestSession {
  deviceId: string
  daemonId: string
  /** The daemon-side keys, ready to seed a provider. */
  daemonSession: DeviceSession
  /** A provider preloaded with this device's daemon-side session. */
  provider: InMemoryDeviceSessionProvider
  /** The device (phone) peer used by the fake gateway to seal/open real frames. */
  device: DevicePeer
}

// Build the phone-side mux from a phone's persisted ROOT keys (the d2p/p2d the phone derived at
// pairing). M6.1: the roots are NEVER an AEAD key directly. On beginChannel the phone draws a fresh
// phoneConnSalt and sends it UNSEALED; when the daemon's ConnSalt arrives the phone calls
// deriveConnectionKeys and seals phone->daemon under the per-connection p2d (opening daemon->phone
// under the per-connection d2p). Shared by createTestSession (synthetic keys) and
// createPairingCeremony (keys from a real deriveDeviceSession over the daemon's transmitted pubkey).
const buildDevicePeer = (args: {
  deviceId: string
  daemonId: string
  roots: { d2p: Uint8Array; p2d: Uint8Array }
  generateConnSalt?: () => Uint8Array
  onSeal?: DeviceSealObserver
}): DevicePeer => {
  const { deviceId, daemonId, roots } = args
  const genSalt = args.generateConnSalt ?? generateConnSalt
  const ids: HandshakeIds = { daemonId, deviceId, protocolVersion: REMOTE_CRYPTO_VERSION }

  let connKeys: ConnectionKeys | null = null
  let sealer: FrameSealer | null = null
  let opener: FrameOpener | null = null
  let phoneConnSalt: Uint8Array | null = null
  // The daemonConnSalt this phone last derived under. A broadcast relay fans the daemon's salt to
  // EVERY phone; one already armed under these exact bytes MUST ignore the re-emit (a no-op re-key)
  // so a second phone's handshake can't reset this phone's seq mid-stream (HARDEN major 4).
  let armedDaemonSalt: Uint8Array | null = null
  let allocStreamId = createStreamIdAllocator('device')

  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const seal = (frameArgs: {
    kind: FrameKind
    streamId: number
    flags?: number
    payload: Uint8Array
  }): Uint8Array => {
    if (!sealer || !connKeys) {
      throw new Error('DevicePeer.seal before the connection handshake completed (no connKeys yet)')
    }
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: frameArgs.kind,
      flags: frameArgs.flags ?? 0,
      streamId: frameArgs.streamId,
      seq: sealer.nextSeq,
    })
    args.onSeal?.({ key: connKeys.p2d, headerBytes })
    const { ciphertext } = sealNext(sealer, {
      key: connKeys.p2d,
      streamId: frameArgs.streamId,
      headerBytes,
      payload: frameArgs.payload,
    })
    const out = new Uint8Array(headerBytes.length + ciphertext.length)
    out.set(headerBytes, 0)
    out.set(ciphertext, headerBytes.length)
    return out
  }

  const onDaemonSalt = (daemonConnSalt: Uint8Array): void => {
    if (!phoneConnSalt) return // ConnSalt without a started channel — ignore
    // No-op re-key guard: a broadcast of the same daemonConnSalt we already armed under must not reset
    // our sealer/opener (it would rewind seq to 0 and desync the daemon's opener for us).
    if (armedDaemonSalt && bytesEqual(armedDaemonSalt, daemonConnSalt)) return
    connKeys = deriveConnectionKeys({
      rootD2p: roots.d2p,
      rootP2d: roots.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids,
    })
    sealer = createSealer('p2d')
    opener = createOpener('d2p')
    armedDaemonSalt = daemonConnSalt
  }

  const sealHello = (): Uint8Array =>
    seal({
      kind: FK.Data,
      streamId: CHANNEL_STREAM_ID,
      payload: encodeHello({
        protocolVersion: REMOTE_CRYPTO_VERSION,
        role: 'device',
        daemonId,
        deviceId,
      }),
    })

  return {
    deviceId,
    nextStreamId: () => allocStreamId(),
    beginChannel: () => {
      phoneConnSalt = genSalt()
      connKeys = null
      sealer = null
      opener = null
      armedDaemonSalt = null
      allocStreamId = createStreamIdAllocator('device')
      const header = encodeHeader({
        version: REMOTE_CRYPTO_VERSION,
        kind: FK.Data,
        flags: 0,
        streamId: CONN_SALT_STREAM_ID,
        seq: 0,
      })
      const body = encodeConnSalt({ role: 'device', salt: phoneConnSalt })
      const frame = new Uint8Array(header.length + body.length)
      frame.set(header, 0)
      frame.set(body, header.length)
      return frame
    },
    seal,
    sealHello,
    open: (frame: Uint8Array) => {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const ciphertext = frame.subarray(HEADER_BYTES)
      const header = decodeHeaderLite(headerBytes)
      // UNSEALED daemon ConnSalt — derive connKeys + arm the sealer/opener before any open.
      if (header.streamId === CONN_SALT_STREAM_ID && isConnSaltPayload(ciphertext)) {
        const msg = decodeConnSalt(ciphertext)
        if (msg.role === 'daemon') onDaemonSalt(msg.salt)
        return { connSalt: true as const }
      }
      if (!opener || !connKeys) {
        throw new Error('DevicePeer.open of a sealed frame before connKeys armed')
      }
      const plaintext = openNext(opener, {
        key: connKeys.d2p,
        streamId: header.streamId,
        headerBytes,
        ciphertext,
        seq: header.seq,
      })
      return { connSalt: false as const, header, plaintext }
    },
    armed: () => connKeys !== null,
  }
}

/**
 * A single matched pair of persisted directional ROOT keys for one (deviceId, daemonId): the daemon's
 * {d2p,p2d} and the phone's {d2p,p2d} that a real pairing handshake would produce. The point of pulling
 * this out of createTestSession is the page-RELOAD scenario (B1/B4): the same persisted root must back
 * BOTH connections. Derive these ONCE, then hand them to createTestSession twice — connection 2 is then
 * a genuine fresh-mux/fresh-bridge over the SAME root, not a freshly-minted random key that would mask
 * the nonce-reuse the regression is supposed to bite on.
 */
export interface MatchedRoots {
  deviceId: string
  daemonId: string
  daemon: { d2p: Uint8Array; p2d: Uint8Array }
  device: { d2p: Uint8Array; p2d: Uint8Array }
}

export const createMatchedRoots = (
  opts: { deviceId?: string; daemonId?: string } = {}
): MatchedRoots => {
  const deviceId = opts.deviceId ?? 'device-test-1'
  const daemonId = opts.daemonId ?? 'daemon-test'
  const ids: HandshakeIds = { daemonId, deviceId, protocolVersion: REMOTE_CRYPTO_VERSION }

  const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = randomBytes(32)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const daemonPk = x25519.getPublicKey(daemonSk)
  const devicePk = x25519.getPublicKey(deviceSk)

  const daemon = deriveDaemonSession({
    daemonSecretKey: daemonSk,
    devicePublicKey: devicePk,
    daemonPublicKey: daemonPk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  const device = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids,
  })

  return {
    deviceId,
    daemonId,
    daemon: { d2p: daemon.d2p, p2d: daemon.p2d },
    device: { d2p: device.d2p, p2d: device.p2d },
  }
}

export const createTestSession = (
  opts: {
    deviceId?: string
    daemonId?: string
    /** Inject deterministic-but-distinct phoneConnSalts (B4 replay test). Defaults to crypto random. */
    generateConnSalt?: () => Uint8Array
    /** Observe every phone->daemon seal's REAL connKey + header (B1/B5 no-reuse recorder). */
    onSeal?: DeviceSealObserver
    /**
     * Reuse a SPECIFIC persisted root (from createMatchedRoots) instead of minting fresh random keys.
     * This is what lets a test model a page reload over ONE persisted device: pass the same roots to
     * two createTestSession calls and the only thing that differs across the two connections is the
     * bilateral salt — exactly the fresh-mux/fresh-bridge-over-one-root scenario the regression bites.
     */
    roots?: MatchedRoots
  } = {}
): TestSession => {
  const roots =
    opts.roots ??
    createMatchedRoots({
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
      ...(opts.daemonId ? { daemonId: opts.daemonId } : {}),
    })
  const deviceId = opts.deviceId ?? roots.deviceId
  const daemonId = opts.daemonId ?? roots.daemonId

  const daemonSession: DeviceSession = {
    deviceId,
    keys: { d2p: roots.daemon.d2p, p2d: roots.daemon.p2d },
  }
  const provider = new InMemoryDeviceSessionProvider()
  provider.set(daemonSession)

  const devicePeer = buildDevicePeer({
    deviceId,
    daemonId,
    // The phone's persisted directional keys are ROOTS now — beginChannel derives the per-connection
    // AEAD keys from them + the bilateral salts.
    roots: { d2p: roots.device.d2p, p2d: roots.device.p2d },
    ...(opts.generateConnSalt ? { generateConnSalt: opts.generateConnSalt } : {}),
    ...(opts.onSeal ? { onSeal: opts.onSeal } : {}),
  })

  return { deviceId, daemonId, daemonSession, provider, device: devicePeer }
}

// ── pairing ceremony (Option B transport simulation; the M5 gateway pairing socket stand-in) ──
//
// createPairingCeremony drives the REAL remote-pairing engine the exact way the M5 gateway pairing
// relay will: beginPairing -> recover the pairing secret FROM THE QR -> generate a phone keypair +
// salt -> submitDeviceHello -> getHandshakeReply (the PairAck) -> deriveDeviceSession over the
// daemon's ACTUALLY-TRANSMITTED public key. Unlike createTestSession (which derives both halves from
// the same local pubkeys and therefore cannot model a MITM), the phone here only ever sees the daemon
// pubkey through the relayed reply — so the tamper hook genuinely diverges the SAS + the directional
// keys, and an S6/U4 MITM assertion bites instead of passing vacuously.
//
// REAL gateway pairing-relay wiring is an M5 DEPENDENCY: in M5 these in-process method calls become
// frames over a pairing-scoped gateway socket a logged-in deviceId=null phone may use, authenticated
// by pairing-secret possession, WITHOUT weakening relay-do.ts's deviceId !== null invariant on the
// normal device path. tests/unit/remote-pairing-transport-contract.test.ts is the binding contract.

export interface PairingCeremony {
  /** The desktop ticket beginPairing returned (carries the QR + the internal pairingId). */
  ticket: { pairingId: string; qr: string; expiresAt: number }
  /** The desktop's pending view after the phone's hello (carries the desktop-side SAS), or null. */
  pending: PendingPairingView | null
  /** The PairAck the transport relayed to the phone (PUBLIC daemon pubkey + ids). */
  reply: HandshakeReply
  /** The pre-allocated device handle (== reply.deviceId). Not a paired device until confirm. */
  deviceId: string
  /** The pairing secret the phone recovered from the QR (test convenience; never on the wire ack). */
  pairingSecret: Uint8Array
  /** The provider the engine is backed by (echoed back so tests can assert pre/post-confirm state). */
  provider: DeviceSessionProvider | null
  /** A phone peer whose keys came from a REAL deriveDeviceSession over the transmitted daemon pubkey. */
  device: DevicePeer & { sessionKeys: SessionKeys }
}

export const createPairingCeremony = (opts: {
  engine: RemotePairing
  /** The provider the engine writes through — echoed back for assertions (no behaviour of its own). */
  provider?: DeviceSessionProvider
  /** Flip a byte of the relayed daemon pubkey before the phone derives — the MITM (S6/U4). */
  tamper?: boolean
  /** A name the phone proposes; surfaced in the desktop confirm dialog. */
  proposedName?: string
}): PairingCeremony => {
  const { engine } = opts

  // 1. Desktop "Add device" -> QR. The pairing secret lives ONLY in the QR string.
  const ticket = engine.beginPairing()
  const payload = decodePairingPayload(ticket.qr)
  const pairingSecret = fromBase64Url(payload.pairingSecret)

  // 2. Phone: fresh keypair + per-session salt, then its hello over the (simulated) pairing transport.
  const kp = generateDeviceKeyPair()
  const sessionSalt = generateSessionSalt()
  const pending = engine.submitDeviceHello({
    pairingId: ticket.pairingId,
    devicePublicKey: kp.publicKey,
    sessionSalt,
    ...(opts.proposedName === undefined ? {} : { proposedName: opts.proposedName }),
  })

  // 3. Transport relays the PairAck (public material only) back to the phone.
  const reply = engine.getHandshakeReply(ticket.pairingId)
  if (!reply) throw new Error('createPairingCeremony: expected a handshake reply')

  // A MITM (the gateway pairing relay) swaps the daemon pubkey in transit; the phone derives against
  // the tampered key. The byte-flip is owned by the transport fixture (tamperDaemonPublicKey).
  const relayedDaemonPub = opts.tamper
    ? tamperDaemonPublicKey(reply.daemonPublicKey)
    : reply.daemonPublicKey

  // 4. Phone completes the handshake from the QR secret + the relayed pubkey — NEVER copying the
  //    daemon's session. This is what makes the SAS/MITM tests genuine.
  const sessionKeys = deriveDeviceSession({
    deviceSecretKey: kp.secretKey,
    daemonPublicKey: relayedDaemonPub,
    devicePublicKey: kp.publicKey,
    pairingSecret,
    sessionSalt,
    ids: {
      daemonId: reply.daemonId,
      deviceId: reply.deviceId,
      protocolVersion: reply.protocolVersion,
    },
  })

  const peer = buildDevicePeer({
    deviceId: reply.deviceId,
    daemonId: reply.daemonId,
    roots: { d2p: sessionKeys.d2p, p2d: sessionKeys.p2d },
  })

  return {
    ticket,
    pending,
    reply,
    deviceId: reply.deviceId,
    pairingSecret,
    provider: opts.provider ?? null,
    device: Object.assign(peer, { sessionKeys }),
  }
}

// Re-export a tiny helper to build an Http/Ws StreamMeta open payload from the device side.
export type { DeviceSessionProvider, StreamMeta }
