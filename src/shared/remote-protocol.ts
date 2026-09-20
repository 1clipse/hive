// Mux frame format + per-stream state machine + flow control + version negotiation.
//
// Runs in BOTH node and browser: no Buffer, no node-only APIs, no I/O, no timers, no crypto.
// Pure synchronous functions over Uint8Array.
//
// THE SEAM (R5, load-bearing): the 12-byte header this module emits via encodeHeader() is exactly
// the bytes remote-crypto authenticates as AEAD AAD, byte-for-byte, with zero transformation. The
// gateway routes on the in-the-clear streamId field; crypto reads streamId@4 and seq@8 out of the
// same bytes to build the nonce. So the wire layout below is a hard contract with remote-crypto.ts:
//   off 0 (u8)   version    off 4 (u32be) streamId   <- crypto reads this
//   off 1 (u8)   kind       off 8 (u32be) seq        <- crypto reads this
//   off 2 (u16be) flags
//
// Failure contract (R4): decode of a malformed/non-canonical frame THROWS ProtocolError (carries a
// ResetCode). State-machine / flow-control rejections return typed results so the caller can emit a
// Reset frame instead of crashing the channel.

// R6 — single wire version: crypto owns it, protocol re-exports it. There is one version integer.
export { REMOTE_CRYPTO_VERSION as PROTOCOL_VERSION } from './remote-crypto.js'

import { REMOTE_CRYPTO_VERSION } from './remote-crypto.js'

export const FrameKind = {
  Open: 0x01,
  Data: 0x02,
  End: 0x03,
  Reset: 0x04,
  Ping: 0x05,
  Ack: 0x06,
} as const
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind]

export const StreamTransport = { Http: 0x01, Ws: 0x02 } as const
export type StreamTransport = (typeof StreamTransport)[keyof typeof StreamTransport]

export const ResetCode = {
  Normal: 0x00,
  ProtocolError: 0x01,
  FlowViolation: 0x02,
  StreamRefused: 0x03,
  VersionMismatch: 0x04,
  InternalError: 0x05,
} as const
export type ResetCode = (typeof ResetCode)[keyof typeof ResetCode]

export const FLOW = { INITIAL_WINDOW: 256 * 1024, ACK_THRESHOLD: 32 * 1024 } as const

export const HEADER_BYTES = 12
export const CHANNEL_STREAM_ID = 0 // reserved: sealed Hello/Ping/Ack-of-channel
// Reserved for the UNSEALED bilateral connection-salt exchange (M6.1). A separate id from
// CHANNEL_STREAM_ID so the demux branches on the cleartext streamId alone — never on a payload byte
// that, for a sealed channel frame, is uniform-random ciphertext (~1/256 false ConnSalt match
// otherwise, silently eating the binding Hello). createStreamIdAllocator never returns this id.
export const CONN_SALT_STREAM_ID = 0xffffffff

const FLAG_FIN = 0x0001 // bit0, only meaningful on Data
const U32_MAX = 0xffffffff

// HTTP data envelope discriminators (§2.3).
const HTTP_DISC_HEAD = 0x00
const HTTP_DISC_BODY = 0x01

// ── error type ──────────────────────────────────────────────────────────────

export class ProtocolError extends Error {
  code: ResetCode
  constructor(message: string, code: ResetCode) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

// ── small byte helpers (no Buffer) ────────────────────────────────────────────

const te = new TextEncoder()
const td = new TextDecoder()

function utf8(s: string): Uint8Array {
  return te.encode(s)
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

function assertU32(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) {
    throw new RangeError(`${name} out of u32 range: ${n}`)
  }
}

function knownKind(k: number): k is FrameKind {
  return (
    k === FrameKind.Open ||
    k === FrameKind.Data ||
    k === FrameKind.End ||
    k === FrameKind.Reset ||
    k === FrameKind.Ping ||
    k === FrameKind.Ack
  )
}

function knownResetCode(c: number): c is ResetCode {
  return (
    c === ResetCode.Normal ||
    c === ResetCode.ProtocolError ||
    c === ResetCode.FlowViolation ||
    c === ResetCode.StreamRefused ||
    c === ResetCode.VersionMismatch ||
    c === ResetCode.InternalError
  )
}

// ── header (12 bytes BE) — this IS the AEAD AAD (R1/R5) ───────────────────────

export interface FrameHeader {
  version: number
  kind: FrameKind
  flags: number
  streamId: number
  seq: number
}

/**
 * bit0 (FIN) is a permitted Data flag; every other bit is reserved-MUST-be-0. So this returns true
 * for 0x0000 and 0x0001 only. The non-Data canonicalization (where even bit0 is reserved) is
 * enforced in decodeHeader, which knows the kind.
 */
export function isReservedFlagsClear(flags: number): boolean {
  return (flags & ~FLAG_FIN) === 0
}

export function encodeHeader(h: FrameHeader): Uint8Array {
  if (h.version !== REMOTE_CRYPTO_VERSION) {
    throw new RangeError(`version must be ${REMOTE_CRYPTO_VERSION}`)
  }
  if (!knownKind(h.kind)) throw new RangeError(`unknown kind: ${h.kind}`)
  if (!Number.isInteger(h.flags) || h.flags < 0 || h.flags > 0xffff) {
    throw new RangeError(`flags out of u16 range: ${h.flags}`)
  }
  // canonicalization mirrors decodeHeader so we can never EMIT a header decode would reject.
  if (h.kind === FrameKind.Data) {
    if (!isReservedFlagsClear(h.flags)) throw new RangeError('reserved flag bits set on Data frame')
  } else if (h.flags !== 0) {
    throw new RangeError('flags must be 0 on a non-Data frame')
  }
  assertU32(h.streamId, 'streamId')
  assertU32(h.seq, 'seq')

  const out = new Uint8Array(HEADER_BYTES)
  const view = dv(out)
  view.setUint8(0, h.version)
  view.setUint8(1, h.kind)
  view.setUint16(2, h.flags)
  view.setUint32(4, h.streamId)
  view.setUint32(8, h.seq)
  return out
}

export function decodeHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new ProtocolError('header too short', ResetCode.ProtocolError)
  }
  const view = dv(bytes)
  const version = view.getUint8(0)
  // version is checked BEFORE anything else (defense-in-depth against a spliced old frame).
  if (version !== REMOTE_CRYPTO_VERSION) {
    throw new ProtocolError(`bad version ${version}`, ResetCode.VersionMismatch)
  }
  const kind = view.getUint8(1)
  if (!knownKind(kind)) {
    throw new ProtocolError(`unknown kind ${kind}`, ResetCode.ProtocolError)
  }
  const flags = view.getUint16(2)
  // Canonical AAD: exactly one valid byte encoding per semantic header.
  if (kind === FrameKind.Data) {
    if (!isReservedFlagsClear(flags)) {
      throw new ProtocolError('reserved flag bits set on Data frame', ResetCode.ProtocolError)
    }
  } else if (flags !== 0) {
    throw new ProtocolError('flags must be 0 on a non-Data frame', ResetCode.ProtocolError)
  }
  const streamId = view.getUint32(4)
  const seq = view.getUint32(8)
  return { version, kind, flags, streamId, seq }
}

// ── payload codecs ────────────────────────────────────────────────────────────

export interface StreamMeta {
  transport: StreamTransport
  http?: { method: string; path: string; headers: [string, string][]; hasBody: boolean }
  // ws.path is path-only (no '?') — the WS query (clientId/cols/rows) rides the separate `query`
  // field so the bridge whitelist can gate the bare path, then reattach the query on the loopback URL.
  ws?: { path: string; query?: [string, string][]; subprotocol?: string }
}

export interface HelloMeta {
  protocolVersion: number
  role: 'daemon' | 'device'
  daemonId: string
  deviceId: string
}

export interface HttpResponseHead {
  status: number
  headers: [string, string][]
}

// Open: [transport:u8][metaLen:u16 BE][meta:utf8 JSON]. JSON arrays keep header order + duplicates.
export function encodeOpenPayload(m: StreamMeta): Uint8Array {
  let meta: unknown
  if (m.transport === StreamTransport.Http) {
    if (!m.http) throw new RangeError('http meta required for Http transport')
    meta = m.http
  } else if (m.transport === StreamTransport.Ws) {
    if (!m.ws) throw new RangeError('ws meta required for Ws transport')
    meta = m.ws
  } else {
    throw new RangeError(`unknown transport: ${m.transport}`)
  }
  const metaBytes = utf8(JSON.stringify(meta))
  if (metaBytes.length > 0xffff) throw new RangeError('open meta too large')
  const out = new Uint8Array(3 + metaBytes.length)
  out[0] = m.transport
  dv(out).setUint16(1, metaBytes.length)
  out.set(metaBytes, 3)
  return out
}

export function decodeOpenPayload(p: Uint8Array): StreamMeta {
  if (p.length < 3) throw new ProtocolError('open payload too short', ResetCode.ProtocolError)
  const transport = p[0] as number
  const metaLen = dv(p).getUint16(1)
  if (p.length !== 3 + metaLen) {
    throw new ProtocolError('open meta length mismatch', ResetCode.ProtocolError)
  }
  let meta: unknown
  try {
    meta = JSON.parse(td.decode(p.subarray(3)))
  } catch {
    throw new ProtocolError('open meta not JSON', ResetCode.ProtocolError)
  }
  if (transport === StreamTransport.Http) {
    const h = meta as Record<string, unknown>
    if (
      typeof h.method !== 'string' ||
      typeof h.path !== 'string' ||
      typeof h.hasBody !== 'boolean' ||
      !isHeaderList(h.headers)
    ) {
      throw new ProtocolError('bad http open meta', ResetCode.ProtocolError)
    }
    return {
      transport: StreamTransport.Http,
      http: { method: h.method, path: h.path, headers: h.headers, hasBody: h.hasBody },
    }
  }
  if (transport === StreamTransport.Ws) {
    const w = meta as Record<string, unknown>
    if (typeof w.path !== 'string') {
      throw new ProtocolError('bad ws open meta', ResetCode.ProtocolError)
    }
    if (w.subprotocol !== undefined && typeof w.subprotocol !== 'string') {
      throw new ProtocolError('bad ws subprotocol', ResetCode.ProtocolError)
    }
    if (w.query !== undefined && !isHeaderList(w.query)) {
      throw new ProtocolError('bad ws query', ResetCode.ProtocolError)
    }
    // exactOptionalPropertyTypes: only attach optional fields when actually present.
    const ws: { path: string; query?: [string, string][]; subprotocol?: string } = { path: w.path }
    if (isHeaderList(w.query)) ws.query = w.query
    if (typeof w.subprotocol === 'string') ws.subprotocol = w.subprotocol
    return { transport: StreamTransport.Ws, ws }
  }
  throw new ProtocolError(`unknown transport ${transport}`, ResetCode.ProtocolError)
}

function isHeaderList(v: unknown): v is [string, string][] {
  if (!Array.isArray(v)) return false
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return false
    if (typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return false
  }
  return true
}

// ── channel handshake (M6.1): unsealed bilateral conn-salt + sealed binding Hello ─────────────
//
// CHANNEL_DISC self-describes each channel-open frame's payload byte 0. It is NOT the demux
// discriminator — the engines branch on the cleartext streamId (CONN_SALT_STREAM_ID vs
// CHANNEL_STREAM_ID), since a sealed Hello's byte 0 is uniform-random ciphertext and can't be
// trusted. The disc is a cheap self-check after the streamId already selected the frame type.
export const CHANNEL_DISC = { ConnSalt: 0x01, Hello: 0x02 } as const
export type ChannelDisc = (typeof CHANNEL_DISC)[keyof typeof CHANNEL_DISC]

export interface ConnSaltMsg {
  role: 'daemon' | 'device'
  salt: Uint8Array // CONN_SALT_LEN (32)
}

// Wire: [disc:0x01][role:u8 (0x01 daemon | 0x02 device)][salt:32 raw]. UNSEALED — rides cleartext on
// CONN_SALT_STREAM_ID. Total 34 bytes. Canonical: decode THROWS ProtocolError on any deviation (R4).
const CONN_ROLE = { daemon: 0x01, device: 0x02 } as const
const CONN_SALT_PAYLOAD_LEN = 34

export function encodeConnSalt(m: ConnSaltMsg): Uint8Array {
  if (m.role !== 'daemon' && m.role !== 'device') throw new RangeError(`bad role: ${m.role}`)
  if (m.salt.length !== 32) throw new RangeError(`conn salt must be 32 bytes, got ${m.salt.length}`)
  const out = new Uint8Array(2 + 32)
  out[0] = CHANNEL_DISC.ConnSalt
  out[1] = m.role === 'daemon' ? CONN_ROLE.daemon : CONN_ROLE.device
  out.set(m.salt, 2)
  return out
}

export function decodeConnSalt(p: Uint8Array): ConnSaltMsg {
  if (p.length !== CONN_SALT_PAYLOAD_LEN) {
    throw new ProtocolError('conn salt must be 34 bytes', ResetCode.ProtocolError)
  }
  if (p[0] !== CHANNEL_DISC.ConnSalt) {
    throw new ProtocolError('not a ConnSalt frame', ResetCode.ProtocolError)
  }
  const roleByte = p[1]
  const role =
    roleByte === CONN_ROLE.daemon ? 'daemon' : roleByte === CONN_ROLE.device ? 'device' : null
  if (role === null) throw new ProtocolError('bad conn salt role', ResetCode.ProtocolError)
  return { role, salt: p.slice(2) }
}

/**
 * True iff a frame's payload self-describes as the unsealed ConnSalt disc. Only consulted for frames
 * that already arrived on CONN_SALT_STREAM_ID — a secondary self-check, NOT the primary demux. The
 * primary demux is the cleartext streamId (a sealed Hello on CHANNEL_STREAM_ID has uniform-random
 * byte 0, so this byte alone is never trusted to route a streamId-0 frame).
 */
export function isConnSaltPayload(payload: Uint8Array): boolean {
  return payload.length >= 1 && payload[0] === CHANNEL_DISC.ConnSalt
}

export function encodeHello(m: HelloMeta): Uint8Array {
  if (m.role !== 'daemon' && m.role !== 'device') throw new RangeError(`bad role: ${m.role}`)
  const json = utf8(JSON.stringify(m))
  const out = new Uint8Array(1 + json.length)
  out[0] = CHANNEL_DISC.Hello
  out.set(json, 1)
  return out
}

export function decodeHello(p: Uint8Array): HelloMeta {
  if (p.length < 1 || p[0] !== CHANNEL_DISC.Hello) {
    throw new ProtocolError('hello missing disc', ResetCode.ProtocolError)
  }
  let raw: unknown
  try {
    raw = JSON.parse(td.decode(p.subarray(1)))
  } catch {
    throw new ProtocolError('hello not JSON', ResetCode.ProtocolError)
  }
  const o = raw as Record<string, unknown>
  if (
    typeof o.protocolVersion !== 'number' ||
    (o.role !== 'daemon' && o.role !== 'device') ||
    typeof o.daemonId !== 'string' ||
    typeof o.deviceId !== 'string'
  ) {
    throw new ProtocolError('bad hello meta', ResetCode.ProtocolError)
  }
  return {
    protocolVersion: o.protocolVersion,
    role: o.role,
    daemonId: o.daemonId,
    deviceId: o.deviceId,
  }
}

export function encodeAckPayload(cumulativeBytes: number): Uint8Array {
  assertU32(cumulativeBytes, 'cumulativeBytes')
  const out = new Uint8Array(4)
  dv(out).setUint32(0, cumulativeBytes)
  return out
}

export function decodeAckPayload(p: Uint8Array): number {
  if (p.length !== 4)
    throw new ProtocolError('ack payload must be 4 bytes', ResetCode.ProtocolError)
  return dv(p).getUint32(0)
}

export function encodeResetPayload(code: ResetCode): Uint8Array {
  if (!knownResetCode(code)) throw new RangeError(`unknown reset code: ${code}`)
  return Uint8Array.of(code)
}

export function decodeResetPayload(p: Uint8Array): ResetCode {
  if (p.length !== 1)
    throw new ProtocolError('reset payload must be 1 byte', ResetCode.ProtocolError)
  const code = p[0] as number
  if (!knownResetCode(code)) {
    throw new ProtocolError(`unknown reset code ${code}`, ResetCode.ProtocolError)
  }
  return code
}

// WS message envelope: [isText:u8 (0x00 bin | 0x01 text)][data...] — binary-safe, no coercion.
export function encodeWsMessage(data: Uint8Array, isText: boolean): Uint8Array {
  const out = new Uint8Array(1 + data.length)
  out[0] = isText ? 0x01 : 0x00
  out.set(data, 1)
  return out
}

export function decodeWsMessage(p: Uint8Array): { data: Uint8Array; isText: boolean } {
  if (p.length < 1) throw new ProtocolError('ws message too short', ResetCode.ProtocolError)
  const flag = p[0] as number
  if (flag !== 0x00 && flag !== 0x01) {
    throw new ProtocolError('bad ws isText flag', ResetCode.ProtocolError)
  }
  // copy out so the caller owns the bytes independent of the framing buffer
  return { data: p.slice(1), isText: flag === 0x01 }
}

// HTTP data envelope: [disc:u8][...]; head = utf8 JSON {status, headers}, body = raw bytes.
export function encodeHttpHead(h: HttpResponseHead): Uint8Array {
  if (!Number.isInteger(h.status) || h.status < 0 || h.status > 0xffff) {
    throw new RangeError(`bad http status: ${h.status}`)
  }
  const json = utf8(JSON.stringify({ status: h.status, headers: h.headers }))
  const out = new Uint8Array(1 + json.length)
  out[0] = HTTP_DISC_HEAD
  out.set(json, 1)
  return out
}

export function encodeHttpBodyChunk(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + b.length)
  out[0] = HTTP_DISC_BODY
  out.set(b, 1)
  return out
}

export function decodeHttpData(
  p: Uint8Array
): { kind: 'head'; head: HttpResponseHead } | { kind: 'body'; data: Uint8Array } {
  if (p.length < 1) throw new ProtocolError('http data too short', ResetCode.ProtocolError)
  const disc = p[0] as number
  if (disc === HTTP_DISC_HEAD) {
    let raw: unknown
    try {
      raw = JSON.parse(td.decode(p.subarray(1)))
    } catch {
      throw new ProtocolError('http head not JSON', ResetCode.ProtocolError)
    }
    const o = raw as Record<string, unknown>
    if (typeof o.status !== 'number' || !isHeaderList(o.headers)) {
      throw new ProtocolError('bad http head', ResetCode.ProtocolError)
    }
    return { kind: 'head', head: { status: o.status, headers: o.headers } }
  }
  if (disc === HTTP_DISC_BODY) {
    return { kind: 'body', data: p.slice(1) }
  }
  throw new ProtocolError(`unknown http disc ${disc}`, ResetCode.ProtocolError)
}

// ── stream id allocator (daemon even, device odd, skip the reserved channel id) ─

export function createStreamIdAllocator(side: 'daemon' | 'device'): () => number {
  if (side !== 'daemon' && side !== 'device') throw new RangeError(`bad side: ${side}`)
  // daemon: 2,4,6...  device: 1,3,5...  — 0 is reserved (CHANNEL_STREAM_ID), never returned.
  // CONN_SALT_STREAM_ID (0xffffffff, odd) is also reserved: skip it so the device side never emits
  // it as a data-stream id, keeping the salt-vs-data demux unambiguous.
  let next = side === 'daemon' ? 2 : 1
  return () => {
    if (next === CONN_SALT_STREAM_ID) next += 2
    const id = next
    next += 2
    if (next > U32_MAX) throw new RangeError('stream id space exhausted; re-handshake required')
    return id
  }
}

// ── per-stream state machine (half-close per direction; §2.4 table) ────────────

export type StreamState = 'idle' | 'open' | 'localClosed' | 'remoteClosed' | 'closed'

export interface StreamMachine {
  state(): StreamState
  onRecv(kind: FrameKind): { ok: true } | { ok: false; reset: ResetCode }
  onSendData(): { ok: true } | { ok: false; reset: ResetCode }
  onLocalEnd(): void
  onReset(): void
}

const OK = { ok: true } as const
function bad(reset: ResetCode = ResetCode.ProtocolError): { ok: false; reset: ResetCode } {
  return { ok: false, reset }
}

export function createStreamMachine(): StreamMachine {
  let state: StreamState = 'idle'

  return {
    state: () => state,

    onRecv(kind) {
      // Reset is always accepted as teardown (idempotent once closed).
      if (kind === FrameKind.Reset) {
        state = 'closed'
        return OK
      }
      switch (state) {
        case 'idle':
          if (kind === FrameKind.Open) {
            state = 'open'
            return OK
          }
          // Data/End before Open is illegal — no lazy auto-open.
          return bad()
        case 'open':
          if (kind === FrameKind.Data) return OK
          if (kind === FrameKind.End) {
            state = 'remoteClosed'
            return OK
          }
          // duplicate Open is a collision
          return bad()
        case 'localClosed':
          // we've half-closed our side; inbound Data still flows until peer End.
          if (kind === FrameKind.Data) return OK
          if (kind === FrameKind.End) {
            state = 'closed'
            return OK
          }
          return bad()
        case 'remoteClosed':
          // peer already sent End — any further Data/End/Open is use-after-close.
          return bad()
        case 'closed':
          return bad()
      }
    },

    onSendData() {
      if (state === 'open' || state === 'remoteClosed') return OK
      return bad()
    },

    onLocalEnd() {
      if (state === 'open') state = 'localClosed'
      else if (state === 'remoteClosed') state = 'closed'
    },

    onReset() {
      state = 'closed'
    },
  }
}

// ── flow control (per-stream credit window; dual-watermark + cumulative ack) ────

export interface FlowController {
  trySend(n: number): { ok: true } | { ok: false; reason: 'WindowExhausted' }
  applyAck(cumulativeBytes: number): { resumed: boolean }
  onConsume(n: number): { ackCumulative: number } | null
  flushAck(): { ackCumulative: number }
  isPaused(): boolean
}

export function createFlowController(
  window: number = FLOW.INITIAL_WINDOW,
  ackThreshold: number = FLOW.ACK_THRESHOLD
): FlowController {
  // sender side
  let sentBytes = 0
  let acked = 0
  // receiver side
  let consumed = 0
  let lastAckedAt = 0

  const unacked = () => sentBytes - acked
  const paused = () => unacked() >= window

  return {
    trySend(n) {
      if (unacked() + n > window) return { ok: false, reason: 'WindowExhausted' }
      sentBytes += n
      return OK
    },

    applyAck(cumulativeBytes) {
      const wasPaused = paused()
      // cumulative, never a delta: ignore a stale/dup ack at or below current acked.
      if (cumulativeBytes <= acked) return { resumed: false }
      // clamp over-ack at sentBytes so the window can never grow past its configured size.
      acked = Math.min(cumulativeBytes, sentBytes)
      const resumed = wasPaused && !paused()
      return { resumed }
    },

    onConsume(n) {
      consumed += n
      if (consumed - lastAckedAt >= ackThreshold) {
        lastAckedAt = consumed
        return { ackCumulative: consumed }
      }
      return null
    },

    flushAck() {
      lastAckedAt = consumed
      return { ackCumulative: consumed }
    },

    isPaused: () => paused(),
  }
}

// ── version negotiation ────────────────────────────────────────────────────────

export function negotiateVersion(
  _localHello: HelloMeta,
  peerHello: HelloMeta
): { ok: true; version: number } | { ok: false; reset: ResetCode } {
  if (peerHello.protocolVersion === REMOTE_CRYPTO_VERSION) {
    return { ok: true, version: REMOTE_CRYPTO_VERSION }
  }
  return { ok: false, reset: ResetCode.VersionMismatch }
}
