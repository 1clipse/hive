// E2E pairing handshake + directional session key schedule + AEAD frame seal/open + SAS.
//
// Runs in BOTH node and browser: no Buffer, no node-only APIs. Bytes are Uint8Array.
//
// Crypto invariants enforced here (each is exercised by tests/unit/remote-crypto.test.ts):
//   1. The 12-byte frame header travels in the clear but is authenticated as AEAD AAD.
//   2. HKDF derives DIRECTIONAL keys (daemon->device vs device->daemon are distinct, never shared).
//   3. The nonce binds (direction, streamId, seq): seq is per-direction monotonic (replay/reorder
//      guard) and streamId is folded in separately so the same key never reuses a nonce across
//      concurrent streams.
//   4. The handshake transcript binds daemonId + deviceId + protocolVersion (+ a fresh per-session
//      salt) so a downgrade / misbind / reroute / reconnect produces different keys.
//
// HARDEN: a fresh 32-byte `sessionSalt` is mandatory at PAIRING time. It is mixed into both the
// HKDF salt and the transcript, so the persisted directional keys (d2p/p2d) are fresh per pairing.
//
// M6.1 — those persisted directional keys are ROOTS, never used as an AEAD key directly. On EVERY
// (re)connect (page reload, daemon reconnect, peer-online) both sides exchange a fresh bilateral
// connection salt and call `deriveConnectionKeys` to derive the per-connection AEAD keys. That is
// what now makes resetting `seq` to 0 per FrameSealer safe: the AEAD key is guaranteed fresh per
// connection (a reload draws a fresh phone salt, a reconnect a fresh daemon salt, and neither side
// can force the other's contribution to repeat), so (key, nonce) reuse is structurally impossible.
// The root is never an AEAD key, so resetting seq under a reused root no longer collides.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const REMOTE_CRYPTO_VERSION = 2 // was 1 — wire handshake changed (mandatory bilateral salt exchange before any sealed frame)

export const X25519_KEY_LEN = 32
export const SHARED_SECRET_LEN = 32
export const SESSION_KEY_LEN = 32
export const NONCE_LEN = 24
export const AEAD_TAG_LEN = 16
export const PAIRING_SECRET_LEN = 32
export const SESSION_SALT_LEN = 32
export const SAS_DIGITS = 6

// M6.1 — per-connection rekey. A fresh bilateral salt every (re)connect derives the AEAD keys from
// the persisted ROOT keys, so seq can reset to 0 per connection without ever reusing (key, nonce).
export const CONN_SALT_LEN = 32

// HKDF labels — ASCII. These ARE the wire contract; changing any string requires bumping the version.
const HKDF_SALT = 'hive/remote/v1/pair'
const INFO_KEY_D2P = 'hive/remote/v1/key/daemon->device'
const INFO_KEY_P2D = 'hive/remote/v1/key/device->daemon'
const INFO_SAS = 'hive/remote/v1/sas'
const TRANSCRIPT_TAG = 'hive/remote/v1/transcript'

// Per-connection key labels. The `conn/*` namespace + ikm=root keeps these disjoint from the
// pairing `v1/*` labels (ikm=pairingSecret||ss), so no label can collide across the two schedules.
const INFO_CONN_D2P = 'hive/remote/v2/conn/daemon->device'
const INFO_CONN_P2D = 'hive/remote/v2/conn/device->daemon'
const CONN_SALT_PREFIX = 'hive/remote/v2/conn-salt'

// Nonce direction tag (nonce[0]); also documents the key->direction mapping.
const DIR_BYTE_D2P = 0x01
const DIR_BYTE_P2D = 0x02

// Header field offsets — crypto reads streamId/seq out of the header bytes (R5 single source of
// truth). MUST match remote-protocol.ts encodeHeader: streamId@4 (u32be), seq@8 (u32be).
const HEADER_OFF_STREAM_ID = 4
const HEADER_OFF_SEQ = 8
const HEADER_MIN_LEN = 12

export type Direction = 'd2p' | 'p2d'

export interface DeviceKeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export interface PairingPayload {
  v: number
  gatewayUrl: string
  daemonId: string
  pairingSecret: string // base64url(32), one-time
}

export interface HandshakeIds {
  daemonId: string
  deviceId: string
  protocolVersion: number
}

export interface SessionKeys {
  d2p: Uint8Array // 32 — daemon seals / device opens
  p2d: Uint8Array // 32 — device seals / daemon opens
  sas: string // /^\d{6}$/
  transcriptHash: Uint8Array // 32
}

export interface FrameSealer {
  direction: Direction
  nextSeq: number
}

export interface FrameOpener {
  direction: Direction
  lastSeq: number
}

// ── private helpers ──────────────────────────────────────────────────────────

const te = new TextEncoder()

function utf8(s: string): Uint8Array {
  return te.encode(s)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`u32be out of range: ${n}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function u32beRead(b: Uint8Array, off = 0): number {
  if (b.length < off + 4) throw new RangeError('u32beRead: buffer too short')
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off)
}

function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`u64be out of range: ${n}`)
  }
  const out = new Uint8Array(8)
  // JS bitwise ops are 32-bit; split into hi/lo 32-bit words.
  const hi = Math.floor(n / 0x1_0000_0000)
  const lo = n >>> 0
  const dv = new DataView(out.buffer)
  dv.setUint32(0, hi)
  dv.setUint32(4, lo)
  return out
}

function lp(b: Uint8Array): Uint8Array {
  if (b.length > 0xffff) throw new RangeError('lp: value too long for u16 length prefix')
  const out = new Uint8Array(2 + b.length)
  new DataView(out.buffer).setUint16(0, b.length)
  out.set(b, 2)
  return out
}

function assertLen(b: Uint8Array, len: number, name: string): void {
  if (b.length !== len) {
    throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`)
  }
}

// ── base64url (no btoa/atob/Buffer) ──────────────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_REVERSE: Int16Array = (() => {
  const r = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    r[B64_ALPHABET.charCodeAt(i)] = i
  }
  return r
})()

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    const b2 = bytes[i + 2] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
    out += B64_ALPHABET[b2 & 0x3f]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const b0 = bytes[i] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[(b0 & 0x03) << 4]
  } else if (rem === 2) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += B64_ALPHABET[(b1 & 0x0f) << 2]
  }
  return out
}

export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new RangeError('invalid base64url')
  const fullGroups = s.length >> 2
  const rem = s.length & 3
  const outLen = fullGroups * 3 + (rem === 0 ? 0 : rem - 1)
  const out = new Uint8Array(outLen)

  const val = (ch: number): number => {
    if (ch >= 128) throw new RangeError('invalid base64url')
    const v = B64_REVERSE[ch] as number
    if (v < 0) throw new RangeError('invalid base64url')
    return v
  }

  let o = 0
  let i = 0
  for (; i + 4 <= s.length; i += 4) {
    const c0 = val(s.charCodeAt(i))
    const c1 = val(s.charCodeAt(i + 1))
    const c2 = val(s.charCodeAt(i + 2))
    const c3 = val(s.charCodeAt(i + 3))
    out[o++] = (c0 << 2) | (c1 >> 4)
    out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2)
    out[o++] = ((c2 & 0x03) << 6) | c3
  }
  if (rem === 2) {
    const c0 = val(s.charCodeAt(i))
    const c1 = val(s.charCodeAt(i + 1))
    out[o++] = (c0 << 2) | (c1 >> 4)
  } else if (rem === 3) {
    const c0 = val(s.charCodeAt(i))
    const c1 = val(s.charCodeAt(i + 1))
    const c2 = val(s.charCodeAt(i + 2))
    out[o++] = (c0 << 2) | (c1 >> 4)
    out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2)
  }
  return out
}

// ── pairing payload (QR) ──────────────────────────────────────────────────────

export function encodePairingPayload(p: PairingPayload): string {
  return JSON.stringify(p)
}

export function decodePairingPayload(s: string): PairingPayload {
  let raw: unknown
  try {
    raw = JSON.parse(s)
  } catch {
    throw new RangeError('invalid pairing payload: not JSON')
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new RangeError('invalid pairing payload: not an object')
  }
  const o = raw as Record<string, unknown>
  if (o.v !== REMOTE_CRYPTO_VERSION) {
    throw new RangeError(`unsupported pairing version: ${String(o.v)}`)
  }
  if (typeof o.gatewayUrl !== 'string' || o.gatewayUrl.length === 0) {
    throw new RangeError('invalid pairing payload: gatewayUrl')
  }
  if (typeof o.daemonId !== 'string' || o.daemonId.length === 0) {
    throw new RangeError('invalid pairing payload: daemonId')
  }
  if (typeof o.pairingSecret !== 'string') {
    throw new RangeError('invalid pairing payload: pairingSecret')
  }
  const secret = fromBase64Url(o.pairingSecret)
  if (secret.length !== PAIRING_SECRET_LEN) {
    throw new RangeError(`pairingSecret must be ${PAIRING_SECRET_LEN} bytes`)
  }
  return {
    v: o.v,
    gatewayUrl: o.gatewayUrl,
    daemonId: o.daemonId,
    pairingSecret: o.pairingSecret,
  }
}

// ── device keypair ─────────────────────────────────────────────────────────────

export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  const publicKey = x25519.getPublicKey(secretKey)
  return { secretKey, publicKey }
}

export function serializeDeviceKeyPair(kp: DeviceKeyPair): {
  secretKey: string
  publicKey: string
} {
  return {
    secretKey: toBase64Url(kp.secretKey),
    publicKey: toBase64Url(kp.publicKey),
  }
}

export function deserializeDeviceKeyPair(s: {
  secretKey: string
  publicKey: string
}): DeviceKeyPair {
  const secretKey = fromBase64Url(s.secretKey)
  const publicKey = fromBase64Url(s.publicKey)
  if (secretKey.length !== X25519_KEY_LEN) {
    throw new RangeError(`secretKey must be ${X25519_KEY_LEN} bytes`)
  }
  if (publicKey.length !== X25519_KEY_LEN) {
    throw new RangeError(`publicKey must be ${X25519_KEY_LEN} bytes`)
  }
  return { secretKey, publicKey }
}

/** A fresh per-session salt. MUST be drawn anew on every (re)connect — see header comment. */
export function generateSessionSalt(): Uint8Array {
  return randomBytes(SESSION_SALT_LEN)
}

// ── key schedule ───────────────────────────────────────────────────────────────

function deriveSession(args: {
  localSecretKey: Uint8Array
  peerPublicKey: Uint8Array
  daemonPublicKey: Uint8Array
  devicePublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys {
  // Length validation up front so IKM/transcript byte boundaries are unambiguous (harden minor).
  assertLen(args.pairingSecret, PAIRING_SECRET_LEN, 'pairingSecret')
  assertLen(args.sessionSalt, SESSION_SALT_LEN, 'sessionSalt')
  assertLen(args.daemonPublicKey, X25519_KEY_LEN, 'daemonPublicKey')
  assertLen(args.devicePublicKey, X25519_KEY_LEN, 'devicePublicKey')

  const ss = x25519.getSharedSecret(args.localSecretKey, args.peerPublicKey)
  assertLen(ss, SHARED_SECRET_LEN, 'sharedSecret')

  // pairingSecret is load-bearing: a passive relay with both pubkeys still can't derive keys.
  const ikm = concat(args.pairingSecret, ss)

  // Fixed daemon/device slots (not self/peer) so both sides hash identical bytes.
  const transcript = concat(
    utf8(TRANSCRIPT_TAG),
    Uint8Array.of(0x00),
    u32be(args.ids.protocolVersion),
    lp(utf8(args.ids.daemonId)),
    lp(utf8(args.ids.deviceId)),
    args.daemonPublicKey,
    args.devicePublicKey,
    args.sessionSalt // fresh per-session randomness → distinct keys every (re)connect
  )
  const transcriptHash = sha256(transcript)

  // HKDF salt also mixes the session salt so a reused (pairing, ss) still gives fresh keys.
  const salt = concat(utf8(HKDF_SALT), args.sessionSalt)

  const d2p = hkdf(
    sha256,
    ikm,
    salt,
    concat(utf8(INFO_KEY_D2P), Uint8Array.of(0x00), transcriptHash),
    SESSION_KEY_LEN
  )
  const p2d = hkdf(
    sha256,
    ikm,
    salt,
    concat(utf8(INFO_KEY_P2D), Uint8Array.of(0x00), transcriptHash),
    SESSION_KEY_LEN
  )
  const sas = deriveSas(transcriptHash, args.ids)
  return { d2p, p2d, sas, transcriptHash }
}

export function deriveDaemonSession(args: {
  daemonSecretKey: Uint8Array // ephemeral — MUST be fresh per handshake (see header comment)
  devicePublicKey: Uint8Array
  daemonPublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys {
  return deriveSession({
    localSecretKey: args.daemonSecretKey,
    peerPublicKey: args.devicePublicKey,
    daemonPublicKey: args.daemonPublicKey,
    devicePublicKey: args.devicePublicKey,
    pairingSecret: args.pairingSecret,
    sessionSalt: args.sessionSalt,
    ids: args.ids,
  })
}

export function deriveDeviceSession(args: {
  deviceSecretKey: Uint8Array
  daemonPublicKey: Uint8Array
  devicePublicKey: Uint8Array
  pairingSecret: Uint8Array
  sessionSalt: Uint8Array
  ids: HandshakeIds
}): SessionKeys {
  return deriveSession({
    localSecretKey: args.deviceSecretKey,
    peerPublicKey: args.daemonPublicKey,
    daemonPublicKey: args.daemonPublicKey,
    devicePublicKey: args.devicePublicKey,
    pairingSecret: args.pairingSecret,
    sessionSalt: args.sessionSalt,
    ids: args.ids,
  })
}

// ── per-connection key schedule (M6.1) ──────────────────────────────────────────

export interface ConnectionKeys {
  d2p: Uint8Array // 32 — per-connection AEAD key; daemon seals / device opens
  p2d: Uint8Array // 32 — per-connection AEAD key; device seals / daemon opens
}

/**
 * A fresh 32-byte connection salt. Drawn anew on EVERY (re)connect (page reload, daemon reconnect,
 * peer-online). Both sides contribute one (bilateral) so neither can force the result to repeat.
 */
export function generateConnSalt(): Uint8Array {
  return randomBytes(CONN_SALT_LEN)
}

/**
 * Derive the two per-connection AEAD keys from the persisted ROOT keys + the bilateral connection
 * salts. Called identically on both sides — same inputs, same byte order ⇒ same ConnectionKeys, so
 * d2p/p2d still match across the wire.
 *
 * The persisted keys (DeviceSession.keys / StoredDeviceSession.rootKeys) are ROOTS: they are never
 * passed to sealFrame/openFrame. This is the ONLY consumer of the root for AEAD purposes.
 *
 *   ikm  = the PER-DIRECTION root (rootD2p→d2p, rootP2d→p2d) — no cross-direction mixing.
 *   salt = CONN_SALT_PREFIX || phoneConnSalt(32) || daemonConnSalt(32)  (bilateral, fixed order).
 *   info = per-direction label || 0x00 || ctx, where ctx binds protocolVersion + ids + both salts.
 *
 * NOTE: the salts appear in BOTH the HKDF salt arg and the info ctx. This is deliberate
 * defense-in-depth, not a leftover — the salt slot makes them the extract entropy, the info slot
 * binds them into the per-direction expand context so the two directions can never coincide and a
 * future label edit can't silently drop the salt binding. Redundant but harmless (HKDF salt and
 * info are independent inputs). A root reused across (deviceId, daemonId, version) yields different
 * connKeys, and the two directions stay distinct (invariant 2).
 */
export function deriveConnectionKeys(args: {
  rootD2p: Uint8Array
  rootP2d: Uint8Array
  phoneConnSalt: Uint8Array
  daemonConnSalt: Uint8Array
  ids: HandshakeIds
}): ConnectionKeys {
  assertLen(args.rootD2p, SESSION_KEY_LEN, 'rootD2p')
  assertLen(args.rootP2d, SESSION_KEY_LEN, 'rootP2d')
  assertLen(args.phoneConnSalt, CONN_SALT_LEN, 'phoneConnSalt')
  assertLen(args.daemonConnSalt, CONN_SALT_LEN, 'daemonConnSalt')

  const salt = concat(utf8(CONN_SALT_PREFIX), args.phoneConnSalt, args.daemonConnSalt)
  const ctx = concat(
    Uint8Array.of(0x00),
    u32be(args.ids.protocolVersion),
    lp(utf8(args.ids.daemonId)),
    lp(utf8(args.ids.deviceId)),
    args.phoneConnSalt,
    args.daemonConnSalt
  )
  const d2p = hkdf(sha256, args.rootD2p, salt, concat(utf8(INFO_CONN_D2P), ctx), SESSION_KEY_LEN)
  const p2d = hkdf(sha256, args.rootP2d, salt, concat(utf8(INFO_CONN_P2D), ctx), SESSION_KEY_LEN)
  return { d2p, p2d }
}

export function deriveSas(transcriptHash: Uint8Array, ids: HandshakeIds): string {
  assertLen(transcriptHash, 32, 'transcriptHash')
  const sasBytes = hkdf(
    sha256,
    transcriptHash,
    utf8(HKDF_SALT),
    concat(utf8(INFO_SAS), Uint8Array.of(0x00), u32be(ids.protocolVersion)),
    4
  )
  const n = u32beRead(sasBytes) % 1_000_000
  return n.toString().padStart(SAS_DIGITS, '0')
}

// ── nonce (invariant 3 — structural uniqueness) ────────────────────────────────

export function buildNonce(direction: Direction, streamId: number, seq: number): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RangeError(`streamId out of range: ${streamId}`)
  }
  const nonce = new Uint8Array(NONCE_LEN)
  nonce[0] = direction === 'd2p' ? DIR_BYTE_D2P : DIR_BYTE_P2D
  nonce.set(u32be(streamId), 1) // bytes 1..4
  // bytes 5..7 stay zero
  nonce.set(u64be(seq), 8) // bytes 8..15 (high 4 zero in M1; seq is u32 on the wire)
  // bytes 16..23 stay zero
  return nonce
}

// ── header field reads (single source of truth — R5) ───────────────────────────

function readStreamId(headerBytes: Uint8Array): number {
  if (headerBytes.length < HEADER_MIN_LEN) {
    throw new RangeError('headerBytes too short')
  }
  return u32beRead(headerBytes, HEADER_OFF_STREAM_ID)
}

function readSeq(headerBytes: Uint8Array): number {
  if (headerBytes.length < HEADER_MIN_LEN) {
    throw new RangeError('headerBytes too short')
  }
  return u32beRead(headerBytes, HEADER_OFF_SEQ)
}

// ── frame seal/open (invariant 1 — header as AAD) ───────────────────────────────

export function sealFrame(args: {
  key: Uint8Array
  direction: Direction
  headerBytes: Uint8Array
  payload: Uint8Array
}): Uint8Array {
  assertLen(args.key, SESSION_KEY_LEN, 'key')
  const streamId = readStreamId(args.headerBytes)
  const seq = readSeq(args.headerBytes)
  const nonce = buildNonce(args.direction, streamId, seq)
  const cipher = xchacha20poly1305(args.key, nonce, args.headerBytes)
  return cipher.encrypt(args.payload)
}

export function openFrame(args: {
  key: Uint8Array
  direction: Direction
  headerBytes: Uint8Array
  ciphertext: Uint8Array
}): Uint8Array {
  assertLen(args.key, SESSION_KEY_LEN, 'key')
  const streamId = readStreamId(args.headerBytes)
  const seq = readSeq(args.headerBytes)
  const nonce = buildNonce(args.direction, streamId, seq)
  const cipher = xchacha20poly1305(args.key, nonce, args.headerBytes)
  return cipher.decrypt(args.ciphertext)
}

// ── stateful replay/reorder guard (invariant 3, sequencing half) — per-direction ─

export function createSealer(direction: Direction): FrameSealer {
  return { direction, nextSeq: 0 }
}

export function createOpener(direction: Direction): FrameOpener {
  return { direction, lastSeq: -1 }
}

export function sealNext(
  sealer: FrameSealer,
  args: {
    key: Uint8Array
    streamId: number
    headerBytes: Uint8Array
    payload: Uint8Array
  }
): { seq: number; ciphertext: Uint8Array } {
  // The header is the source of truth for streamId/seq; verify the caller's seq matches.
  const headerSeq = readSeq(args.headerBytes)
  if (headerSeq !== sealer.nextSeq) {
    throw new RangeError(`header seq ${headerSeq} does not match sealer.nextSeq ${sealer.nextSeq}`)
  }
  const ciphertext = sealFrame({
    key: args.key,
    direction: sealer.direction,
    headerBytes: args.headerBytes,
    payload: args.payload,
  })
  const seq = sealer.nextSeq
  sealer.nextSeq += 1
  return { seq, ciphertext }
}

export function openNext(
  opener: FrameOpener,
  args: {
    key: Uint8Array
    streamId: number
    headerBytes: Uint8Array
    ciphertext: Uint8Array
    seq: number
  }
): Uint8Array {
  if (args.seq !== opener.lastSeq + 1) {
    throw new RangeError('out-of-order or replayed frame')
  }
  const headerSeq = readSeq(args.headerBytes)
  if (headerSeq !== args.seq) {
    throw new RangeError('out-of-order or replayed frame')
  }
  const plaintext = openFrame({
    key: args.key,
    direction: opener.direction,
    headerBytes: args.headerBytes,
    ciphertext: args.ciphertext,
  })
  opener.lastSeq = args.seq
  return plaintext
}
