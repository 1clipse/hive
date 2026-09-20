// Phone-side mux — the mirror of the daemon's remote-frame-bridge, originating instead of answering.
//
//   fetch('/api/*')        -> seal an Http Open (+ body Data + End) -> open the sealed Data frames the
//                             daemon seals back -> reassemble status/headers/body into a real Response.
//   openWebSocket('/ws/*') -> seal a Ws Open -> map socket.send to sealed Data, socket.close to End,
//                             inbound Data to onmessage, inbound End/Reset to onclose.
//
// Crypto is M1+M6.1, not mocked. The persisted d2p/p2d are ROOTS — never an AEAD key directly. On
// EVERY (re)connect the mux draws a fresh phoneConnSalt, exchanges it UNSEALED on CONN_SALT_STREAM_ID,
// and on receiving the daemon's salt derives the per-connection AEAD keys via deriveConnectionKeys.
// Only then does one FrameSealer('p2d') seal every outbound sealed frame under connKeys.p2d (and one
// FrameOpener('d2p') open every inbound under connKeys.d2p). A reload builds a fresh mux that draws a
// fresh phone salt, so seq can reset to 0 per connection without ever reusing (key, nonce). A frame
// that fails openNext THROWS — never delivered (invariant 4). The device allocates odd stream ids;
// CHANNEL_STREAM_ID(0) carries the SEALED binding Hello; CONN_SALT_STREAM_ID the unsealed salt.

import {
  type ConnectionKeys,
  createOpener,
  createSealer,
  generateConnSalt as defaultGenerateConnSalt,
  deriveConnectionKeys,
  type FrameOpener,
  type FrameSealer,
  openNext,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../../../src/shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  createFlowController,
  createStreamIdAllocator,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  decodeWsMessage,
  encodeAckPayload,
  encodeConnSalt,
  encodeHeader,
  encodeHello,
  encodeHttpBodyChunk,
  encodeOpenPayload,
  encodeWsMessage,
  type FlowController,
  FrameKind,
  HEADER_BYTES,
  type HttpResponseHead,
  isConnSaltPayload,
  StreamTransport,
} from '../../../src/shared/remote-protocol.js'
import type { TransportSocket } from './api-transport.js'

const FLAG_FIN = 0x0001

// Upper bound for one HTTP request-body Data frame. The gateway relay (a Cloudflare Durable Object)
// enforces a 1 MiB per-WebSocket-message platform cap, so a body sent as a single sealed frame dies
// at the relay for anything larger — which is exactly what a phone photo/video evidence upload is.
// 256 KiB keeps each sealed frame (payload + 12B header + AEAD tag + 1B disc) far under the cap while
// not flooding the relay with tiny messages. The daemon bridge streams chunks to loopback as they
// arrive, so chunk count has no daemon-side cost.
export const HTTP_BODY_CHUNK_BYTES = 256 * 1024

const te = new TextEncoder()
const td = new TextDecoder()

export interface FrameMuxDeps {
  /** PERSISTED ROOT keys — never used as an AEAD key directly. deriveConnectionKeys is the only consumer. */
  roots: { d2p: Uint8Array; p2d: Uint8Array }
  daemonId: string
  deviceId: string
  /** Push a frame onto the relay socket. */
  send: (frame: Uint8Array) => void
  /** Seam (tests): defaults to crypto.generateConnSalt. Drawn fresh on every beginChannel(). */
  generateConnSalt?: () => Uint8Array
  /**
   * Observation hook (NOT a mock): fires for every sealed frame with the REAL key + REAL header the
   * production seal path used. Lets the no-nonce-reuse regression prove no frame is ever sealed under
   * the root. Never mutates the frame.
   */
  onSeal?: (rec: { key: Uint8Array; direction: 'p2d'; headerBytes: Uint8Array }) => void
  /** Fires once the bilateral salt exchange has derived connKeys and the sealed binding Hello was sent. */
  onReady?: () => void
  /**
   * Backpressure seam for multi-chunk HTTP bodies: awaited between body chunks so the transport can
   * hold the loop while the relay socket's buffered amount is high (a 100MB upload must not be
   * mirrored wholesale into the WebSocket send buffer). Optional — absent means no pacing.
   */
  awaitDrain?: () => Promise<void>
}

export interface FrameMux {
  /**
   * Begin a connection: draw a fresh phoneConnSalt, drop any prior connKeys/sealer/opener, restart the
   * stream-id allocator, and send the UNSEALED ConnSalt on CONN_SALT_STREAM_ID. Call on EVERY
   * (re)connect (onUp / peer-online). The sealed binding Hello is deferred until the daemon's salt
   * arrives — see onDaemonSalt.
   */
  beginChannel(): void
  /** Feed an inbound frame off the relay socket. Routes the unsealed ConnSalt; drops an unopenable sealed frame. */
  onFrame(frame: Uint8Array): void
  fetch(path: string, init?: RequestInit): Promise<Response>
  openWebSocket(path: string, params?: Record<string, number | string | undefined>): TransportSocket
  /** Fail every in-flight stream (socket dropped). Pending fetches reject; ws sockets close. */
  resetAll(reason: string): void
}

interface HttpStream {
  kind: 'http'
  head?: HttpResponseHead
  body: Uint8Array[]
  recvFlow: FlowController
  resolve: (r: Response) => void
  reject: (e: unknown) => void
  settled: boolean
}

// The phone-side ws socket the mux hands back: the public TransportSocket plus two internal hooks the
// mux uses to push inbound data / drive a remote close. Declared here so WsStream can name it before
// the MuxSocket class is defined inside the factory.
interface MuxWsSocket extends TransportSocket {
  readonly streamId: number
  _deliver(bytes: Uint8Array, isText: boolean): void
  _remoteClose(code: number, reason?: string): void
}

interface WsStream {
  kind: 'ws'
  recvFlow: FlowController
  socket: MuxWsSocket
}

type Stream = HttpStream | WsStream

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

const toBytes = (
  data: string | ArrayBufferLike | ArrayBufferView
): { bytes: Uint8Array; isText: boolean } => {
  if (typeof data === 'string') return { bytes: te.encode(data), isText: true }
  if (data instanceof Uint8Array) return { bytes: data, isText: false }
  if (data instanceof ArrayBuffer) return { bytes: new Uint8Array(data), isText: false }
  const view = data as ArrayBufferView
  return { bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength), isText: false }
}

export const createFrameMux = (deps: FrameMuxDeps): FrameMux => {
  const genSalt = deps.generateConnSalt ?? defaultGenerateConnSalt
  // Per-connection state — all nullable until the bilateral salt exchange completes. seal/open before
  // connKeys exist is a programming error (callers gate on it); the root is NEVER an AEAD key.
  let connKeys: ConnectionKeys | null = null
  let sealer: FrameSealer | null = null
  let opener: FrameOpener | null = null
  let phoneConnSalt: Uint8Array | null = null
  // The daemon ConnSalt this phone has already armed under for the current
  // phoneConnSalt. The relay can legitimately deliver the same daemon salt
  // twice on one socket (attach + re-emit after our phone salt); that must be a
  // no-op, not a sealer/opener rewind to seq 0.
  let armedDaemonSalt: Uint8Array | null = null
  let allocStreamId = createStreamIdAllocator('device')
  const streams = new Map<number, Stream>()

  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const seal = (kind: FrameKind, streamId: number, payload: Uint8Array, flags = 0): Uint8Array => {
    if (!sealer || !connKeys) {
      throw new Error('frame-mux: seal before channel handshake complete')
    }
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind,
      flags,
      streamId,
      seq: sealer.nextSeq,
    })
    deps.onSeal?.({ key: connKeys.p2d, direction: 'p2d', headerBytes })
    const { ciphertext } = sealNext(sealer, { key: connKeys.p2d, streamId, headerBytes, payload })
    const out = new Uint8Array(headerBytes.length + ciphertext.length)
    out.set(headerBytes, 0)
    out.set(ciphertext, headerBytes.length)
    return out
  }

  // The sealed binding Hello on (CHANNEL_STREAM_ID, seq 0) under connKeys.p2d — proves key possession
  // so the daemon's trial-open binds this device. Sent once connKeys are derived.
  const sealHelloInternal = (): void => {
    deps.send(
      seal(
        FrameKind.Data,
        CHANNEL_STREAM_ID,
        encodeHello({
          protocolVersion: REMOTE_CRYPTO_VERSION,
          role: 'device',
          daemonId: deps.daemonId,
          deviceId: deps.deviceId,
        })
      )
    )
  }

  // Daemon's half of the bilateral exchange arrived: derive the per-connection AEAD keys from the
  // persisted ROOT + both salts, arm a fresh sealer/opener at seq 0, and send the sealed Hello.
  const onDaemonSalt = (daemonConnSalt: Uint8Array): void => {
    if (!phoneConnSalt) return // a daemon salt without a started channel — ignore
    if (armedDaemonSalt && bytesEqual(armedDaemonSalt, daemonConnSalt)) return
    connKeys = deriveConnectionKeys({
      rootD2p: deps.roots.d2p,
      rootP2d: deps.roots.p2d,
      phoneConnSalt,
      daemonConnSalt,
      ids: {
        daemonId: deps.daemonId,
        deviceId: deps.deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      },
    })
    sealer = createSealer('p2d')
    opener = createOpener('d2p')
    armedDaemonSalt = Uint8Array.from(daemonConnSalt)
    sealHelloInternal()
    deps.onReady?.()
  }

  const sealAck = (streamId: number, cumulative: number): void => {
    deps.send(seal(FrameKind.Ack, streamId, encodeAckPayload(cumulative)))
  }

  // ── HTTP ──
  const startHttp = (path: string, init?: RequestInit): Promise<Response> => {
    // Fail closed before the salt RTT completes — NEVER seal under the root. In practice the relay
    // onUp -> beginChannel -> daemon ConnSalt round-trip is sub-frame, so app fetches see connKeys;
    // this gate is the correctness backstop, not the hot path.
    if (!connKeys) return Promise.reject(new Error('tunnel: channel not ready'))
    const streamId = allocStreamId()
    const method = (init?.method ?? 'GET').toUpperCase()

    const headers: [string, string][] = []
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit)
      h.forEach((value, key) => {
        headers.push([key, value])
      })
    }
    // No UI cookie rides the tunnel: tunnel /api/* is authorized by the daemon's per-boot internal
    // secret (the bridge stamps x-hive-remote-secret on the loopback request; requireUiTokenFromRequest
    // short-circuits on it), and /api/ui/session is hard-denied to the tunnel. The phone never holds
    // hive_ui_token, so there is nothing to replay — see the note in tunnel-transport.ts.

    const bodyBytes =
      init?.body === undefined || init.body === null ? undefined : encodeBody(init.body)
    const hasBody = bodyBytes !== undefined && bodyBytes.length > 0

    return new Promise<Response>((resolve, reject) => {
      const stream: HttpStream = {
        kind: 'http',
        body: [],
        recvFlow: createFlowController(),
        resolve,
        reject,
        settled: false,
      }
      streams.set(streamId, stream)
      deps.send(
        seal(
          FrameKind.Open,
          streamId,
          encodeOpenPayload({
            transport: StreamTransport.Http,
            http: { method, path, headers, hasBody },
          })
        )
      )
      if (hasBody && bodyBytes) {
        if (bodyBytes.length <= HTTP_BODY_CHUNK_BYTES) {
          // Single-chunk fast path: byte-identical to the historical behavior (and synchronous, so
          // existing send-ordering expectations for small JSON bodies are untouched).
          deps.send(seal(FrameKind.Data, streamId, encodeHttpBodyChunk(bodyBytes)))
          deps.send(seal(FrameKind.End, streamId, new Uint8Array(0)))
        } else {
          void sendChunkedHttpBody(streamId, stream, bodyBytes)
        }
      } else {
        deps.send(seal(FrameKind.End, streamId, new Uint8Array(0)))
      }
    })
  }

  // Multi-chunk body sender. Interleaving with other streams' frames is fine (that is what the mux
  // is for); the invariants are per-stream ordering (Data chunks in offset order, End strictly last)
  // and STOPPING when the stream settles under us — a rekey/disconnect resetAll() rejects the fetch
  // and replaces the sealer, and sealing stale chunks under the next connection's keys would corrupt
  // that stream. seal() itself also throws once the sealer is dropped, as a second net.
  const sendChunkedHttpBody = async (
    streamId: number,
    stream: HttpStream,
    bodyBytes: Uint8Array
  ): Promise<void> => {
    try {
      for (let offset = 0; offset < bodyBytes.length; offset += HTTP_BODY_CHUNK_BYTES) {
        if (offset > 0 && deps.awaitDrain) await deps.awaitDrain()
        if (stream.settled) return
        deps.send(
          seal(
            FrameKind.Data,
            streamId,
            encodeHttpBodyChunk(bodyBytes.subarray(offset, offset + HTTP_BODY_CHUNK_BYTES))
          )
        )
      }
      if (stream.settled) return
      deps.send(seal(FrameKind.End, streamId, new Uint8Array(0)))
    } catch (err) {
      if (stream.settled) return
      stream.settled = true
      streams.delete(streamId)
      stream.reject(err)
    }
  }

  const finishHttp = (streamId: number, st: HttpStream): void => {
    if (st.settled) return
    st.settled = true
    streams.delete(streamId)
    const head = st.head
    const body = concatBytes(st.body)
    // A completed stream with no head is a protocol failure — never fabricate a 200.
    if (!head) {
      st.reject(new Error('tunnel: stream ended without an HTTP head'))
      return
    }
    // BodyInit wants a plain-ArrayBuffer-backed BufferSource. concatBytes already returns a fresh,
    // tightly-sized Uint8Array, so copy it into a new ArrayBuffer to satisfy the lib types (and to
    // drop any SharedArrayBuffer backing).
    let responseBody: ArrayBuffer | null = null
    if (body.length > 0) {
      const buf = new ArrayBuffer(body.length)
      new Uint8Array(buf).set(body)
      responseBody = buf
    }
    st.resolve(new Response(responseBody, { status: head.status, headers: head.headers }))
  }

  // ── WS ──
  class MuxSocket implements MuxWsSocket {
    readonly OPEN = 1
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string | ArrayBufferLike | Uint8Array }) => void) | null = null
    onclose: ((event: { code?: number; reason?: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    readonly streamId: number

    constructor(streamId: number) {
      this.streamId = streamId
    }

    send(data: string | ArrayBufferLike | ArrayBufferView): void {
      if (this.readyState !== this.OPEN) return
      const { bytes, isText } = toBytes(data)
      deps.send(seal(FrameKind.Data, this.streamId, encodeWsMessage(bytes, isText)))
    }

    close(_code?: number, _reason?: string): void {
      if (this.readyState === 3) return
      const wasOpen = this.readyState === this.OPEN
      this.readyState = 3
      if (wasOpen) deps.send(seal(FrameKind.End, this.streamId, new Uint8Array(0)))
      streams.delete(this.streamId)
    }

    // internal: deliver an inbound message
    _deliver(bytes: Uint8Array, isText: boolean): void {
      if (!this.onmessage) return
      this.onmessage({ data: isText ? td.decode(bytes) : bytes })
    }

    _remoteClose(code: number, reason?: string): void {
      if (this.readyState === 3) return
      this.readyState = 3
      streams.delete(this.streamId)
      this.onclose?.(reason === undefined ? { code } : { code, reason })
    }
  }

  const startWs = (
    path: string,
    params?: Record<string, number | string | undefined>
  ): TransportSocket => {
    // Fail closed before the salt exchange completes — never seal an Open under the root. Hand back a
    // socket that closes itself on the next microtask (matches a refused open), never one that seals.
    if (!connKeys) {
      const dead = new MuxSocket(-1)
      queueMicrotask(() => dead._remoteClose(1011, 'tunnel: channel not ready'))
      return dead
    }
    const streamId = allocStreamId()
    // The WS query (clientId/cols/rows) rides the dedicated StreamMeta.ws.query field — NOT the path.
    // The daemon's classifyOpen whitelist rejects any '?' in a WS path; the bridge reattaches these
    // pairs onto the loopback URL so terminal-ws-server reads clientId/cols/rows from url.searchParams.
    const query: [string, string][] = []
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) query.push([k, String(v)])
      }
    }
    const socket = new MuxSocket(streamId)
    streams.set(streamId, { kind: 'ws', recvFlow: createFlowController(), socket })
    deps.send(
      seal(
        FrameKind.Open,
        streamId,
        encodeOpenPayload({
          transport: StreamTransport.Ws,
          ws: query.length > 0 ? { path, query } : { path },
        })
      )
    )
    // Open optimistically; the daemon upgrades the loopback ws and the first inbound frame (or any
    // send) flows once the relay is up. Mark OPEN on the next microtask so onopen handlers attach.
    queueMicrotask(() => {
      if (socket.readyState === 0) {
        socket.readyState = socket.OPEN
        socket.onopen?.()
      }
    })
    return socket
  }

  return {
    beginChannel() {
      // Draw a fresh phone salt + drop any prior connection state. Fail in-flight streams from the
      // prior connection, then restart the allocator at 1 (safe now — freshness comes from connKey,
      // not seq monotonicity). The sealed Hello waits for the daemon's salt (onDaemonSalt).
      phoneConnSalt = genSalt()
      connKeys = null
      sealer = null
      opener = null
      armedDaemonSalt = null
      this.resetAll('rekey')
      allocStreamId = createStreamIdAllocator('device')
      // UNSEALED ConnSalt on its own reserved stream — no sealer touched, seq literal 0.
      const headerBytes = encodeHeader({
        version: REMOTE_CRYPTO_VERSION,
        kind: FrameKind.Data,
        flags: 0,
        streamId: CONN_SALT_STREAM_ID,
        seq: 0,
      })
      const body = encodeConnSalt({ role: 'device', salt: phoneConnSalt })
      const out = new Uint8Array(headerBytes.length + body.length)
      out.set(headerBytes, 0)
      out.set(body, headerBytes.length)
      deps.send(out)
    },

    onFrame(frame) {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const payload = frame.subarray(HEADER_BYTES)
      const header = decodeHeader(headerBytes)
      // UNSEALED channel ConnSalt: demux on the cleartext streamId (never on a payload byte that, for
      // a sealed frame, is uniform-random ciphertext). Handle BEFORE any open — no connKey exists yet.
      if (header.streamId === CONN_SALT_STREAM_ID && isConnSaltPayload(payload)) {
        const { role, salt } = decodeConnSalt(payload)
        if (role === 'daemon') onDaemonSalt(salt)
        return
      }
      // SEALED path — needs connKeys/opener. A sealed frame before the handshake completes is dropped.
      if (!opener || !connKeys) return
      // Foreign-device frames (RelayDO broadcast) fail AEAD / seq. Drop them; do not tear the session.
      // A real replay of *our* seq still fails openNext and is dropped the same way.
      let plaintext: Uint8Array
      try {
        plaintext = openNext(opener, {
          key: connKeys.d2p,
          streamId: header.streamId,
          headerBytes,
          ciphertext: payload,
          seq: header.seq,
        })
      } catch (error) {
        console.warn('[hive] dropped unopenable relay frame', error)
        const failed = streams.get(header.streamId)
        if (failed?.kind === 'http' && !failed.settled) {
          failed.settled = true
          streams.delete(header.streamId)
          failed.reject(new Error('tunnel: unopenable frame'))
        }
        return
      }
      if (header.streamId === CHANNEL_STREAM_ID) return
      const stream = streams.get(header.streamId)
      if (!stream) return

      if (stream.kind === 'http') {
        if (header.kind === FrameKind.Reset) {
          if (!stream.settled) {
            stream.settled = true
            streams.delete(header.streamId)
            stream.reject(new Error('tunnel: HTTP stream reset by daemon'))
          }
          return
        }
        if (header.kind === FrameKind.Data) {
          const decoded = decodeHttpData(plaintext)
          if (decoded.kind === 'head') stream.head = decoded.head
          else {
            stream.body.push(decoded.data)
            const ack = stream.recvFlow.onConsume(decoded.data.length)
            if (ack) sealAck(header.streamId, ack.ackCumulative)
          }
          // Accept BOTH completion forms: FIN-on-Data OR a trailing End frame.
          if ((header.flags & FLAG_FIN) !== 0) finishHttp(header.streamId, stream)
          return
        }
        if (header.kind === FrameKind.End) {
          finishHttp(header.streamId, stream)
          return
        }
        return
      }

      // ws
      if (header.kind === FrameKind.Data) {
        const msg = decodeWsMessage(plaintext)
        const ack = stream.recvFlow.onConsume(msg.data.length)
        if (ack) sealAck(header.streamId, ack.ackCumulative)
        stream.socket._deliver(msg.data, msg.isText)
        return
      }
      if (header.kind === FrameKind.End || header.kind === FrameKind.Reset) {
        stream.socket._remoteClose(header.kind === FrameKind.Reset ? 1011 : 1000)
        return
      }
    },

    fetch: startHttp,
    openWebSocket: startWs,

    resetAll(reason) {
      for (const [streamId, stream] of [...streams.entries()]) {
        streams.delete(streamId)
        if (stream.kind === 'http') {
          if (!stream.settled) {
            stream.settled = true
            stream.reject(new Error(`tunnel: connection lost (${reason})`))
          }
        } else {
          stream.socket._remoteClose(1006, reason)
        }
      }
    },
  }
}

const encodeBody = (body: BodyInit): Uint8Array => {
  if (typeof body === 'string') return te.encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  // URLSearchParams / Blob / FormData are not used by api.ts (it only sends JSON strings); coerce
  // anything else through its string form so we never silently drop a body.
  return te.encode(String(body))
}
