import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { type RawData, WebSocket, WebSocketServer } from 'ws'

import {
  type GatewayControl,
  GW_CONTROL_PREFIX,
  RelayCloseCode,
} from '../../src/server/remote-control-constants.js'
import {
  createFlowController,
  decodeHttpData,
  decodeResetPayload,
  decodeWsMessage,
  encodeAckPayload,
  encodeHttpBodyChunk,
  encodeOpenPayload,
  encodeWsMessage,
  type FlowController,
  FrameKind,
  type HttpResponseHead,
  type ResetCode,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'
import { unwrapRelayRoute } from '../../src/shared/remote-relay-route.js'
import type { DevicePeer } from './remote-test-session.js'

// A REAL `ws` server standing in for the gateway relay's daemon endpoint
// (gateway/src/relay-do.ts `/relay/daemon`). This is NOT a mock of the tunnel or of node-pty — it
// is a genuine network server, bound to 127.0.0.1, that the daemon's outbound WebSocket actually
// connects to. It plays only the RELAY half of M2 here (the device/phone + M1 crypto half lives in
// remote-test-session.ts, used by the bridge tests). What this fixture proves for the tunnel stage:
//   - the daemon presents `bearer.<token>` in Sec-WebSocket-Protocol (rejected when wrong → 401)
//   - the daemon answers the gateway keepalive: it SENDS 'hb:ping', the DO auto-replies 'hb:pong'
//   - drop()/restart() on the SAME port exercises reconnect
//   - sendControl() emits the exact sentinel-prefixed control wire format (revoked etc.)

export const HB_PING = 'hb:ping'
export const HB_PONG = 'hb:pong'

export interface FakeGatewayOptions {
  /** The bearer token the daemon must present. A mismatch → upgrade rejected (401). */
  expectedToken: string
  /**
   * When true, the server auto-replies 'hb:pong' to every 'hb:ping' string, mirroring the DO's
   * setWebSocketAutoResponse. Defaults to true; set false to simulate a dead gateway (heartbeat
   * deadline must then fire on the daemon side).
   */
  autoPong?: boolean
  /**
   * The device (phone) M1 peer. When present, the fixture also plays the phone end: it seals real
   * mux frames with the device's p2d key and opens the daemon's responses with d2p. This is what
   * lets openHttp()/openWs() drive a true end-to-end exchange through the bridge. Without it the
   * fixture is relay-only (the lifecycle tests).
   */
  device?: DevicePeer
}

/** A bridged HTTP request's result, reassembled on the phone side. */
export interface PhoneHttpResult {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

/** A bridged WS stream, driven from the phone side. */
export interface PhoneWsStream {
  /** Send a phone->daemon message (binary-safe). */
  send(data: Uint8Array, isText: boolean): void
  /** Register a handler for daemon->phone messages decoded off the stream. */
  onMessage(cb: (data: Uint8Array, isText: boolean) => void): void
  /** Resolves on the next daemon->phone message (one-shot). */
  next(timeoutMs?: number): Promise<{ data: Uint8Array; isText: boolean }>
  /** Locally close (send End). */
  close(): void
  /** True once the daemon Reset/End-ed the stream. */
  closed(): boolean
  /**
   * Total daemon->phone Data bytes received on this stream so far. A SLOW phone that never acks (this
   * fixture never seals an Ack back to the daemon) caps this at the daemon's sender window once the
   * VULN-RELIABILITY-1 fix lands; without the fix the daemon drains the whole producer onto the wire.
   */
  bytesReceived(): number
}

export interface FakeGateway {
  /** ws://127.0.0.1:<port> — the daemon builds `${url}/relay/daemon` from a gatewayUrl. */
  readonly url: string
  /** Total daemon upgrades accepted across the fixture's lifetime (survives drop/restart). */
  connectionCount(): number
  /** The Sec-WebSocket-Protocol the most recent daemon presented. */
  lastDaemonProtocol(): string | undefined
  /** Number of 'hb:ping' heartbeats observed. */
  pingCount(): number
  /** Resolves once at least one daemon socket is connected. */
  waitForDaemon(timeoutMs?: number): Promise<void>
  /** Resolves once at least `n` 'hb:ping' heartbeats have been observed. */
  waitForPings(n: number, timeoutMs?: number): Promise<void>
  /** Send a gateway control frame to the connected daemon (sentinel-prefixed JSON). */
  sendControl(c: GatewayControl): void
  /** Send a raw binary frame to the connected daemon (opaque E2E bytes). */
  sendBinary(data: Uint8Array): void
  /** Last opaque binary frame the daemon sent up to the gateway, if any. */
  lastBinaryFromDaemon(): Uint8Array | undefined
  /**
   * Drive a full HTTP request from the phone side: seal an Open (+ optional body), collect the
   * sealed Data frames the daemon sends back, and reassemble status/headers/body. Requires a device.
   */
  openHttp(req: {
    method: string
    path: string
    headers?: Array<[string, string]>
    body?: Uint8Array
  }): Promise<PhoneHttpResult>
  /**
   * Open a WS stream from the phone side and return a handle to drive it. Requires a device. Pass
   * `noAck: true` to model a slow/stalled phone that never seals an Ack back (exercises the daemon's
   * daemon->phone sender window / VULN-RELIABILITY-1 backpressure).
   */
  openWs(req: { path: string; noAck?: boolean }): Promise<PhoneWsStream>
  /** Send a single raw (already-sealed) frame to the daemon — used to replay a captured frame. */
  sendSealed(frame: Uint8Array): void
  /** Begin a fresh phone channel over the SAME live daemon socket (same device, new phoneConnSalt). */
  rehandshakeDevice(): Promise<void>
  /** Hard-drop the current daemon socket(s) without closing the server (network blip). */
  dropDaemon(): void
  /** Tear down the listening server (keeps the port reservation released). */
  stopListening(): Promise<void>
  /** Re-listen on the SAME port after stopListening — drives reconnect-to-same-endpoint. */
  restart(): Promise<void>
  /** Full teardown. */
  close(): Promise<void>
}

// The MITM on the Option-B pairing transport: a hostile relay flips a byte of the daemon public key
// in the PairAck it forwards to the phone. The phone then runs deriveDeviceSession against the wrong
// key, so its SAS + directional keys diverge from the daemon's — exactly what the human SAS comparison
// catches, and what makes a careless confirm still fail to open any relay stream (AEAD). Owned by the
// transport fixture (it models the gateway pairing relay), consumed by createPairingCeremony.
//
// M5 DEPENDENCY: in the real gateway pairing-relay, this byte lives on the wire of the pairing socket;
// here it is applied in-process. The divergence it produces is identical either way.
export const tamperDaemonPublicKey = (daemonPublicKey: Uint8Array): Uint8Array => {
  const out = Uint8Array.from(daemonPublicKey)
  out[0] = (out[0] ?? 0) ^ 0x01
  return out
}

export const startFakeGateway = async (options: FakeGatewayOptions): Promise<FakeGateway> => {
  const autoPong = options.autoPong ?? true
  let connections = 0
  let lastProtocol: string | undefined
  let pings = 0
  let lastBinary: Uint8Array | undefined
  const sockets = new Set<WebSocket>()

  let wss: WebSocketServer
  let port = 0

  const daemonWaiters: Array<() => void> = []
  const pingWaiters: Array<{ need: number; resolve: () => void }> = []

  // ── device (phone) demux state — only used when options.device is present ──
  const device = options.device
  interface HttpPending {
    head?: HttpResponseHead
    body: Uint8Array[]
    resolve: (r: PhoneHttpResult) => void
    reject: (e: unknown) => void
    settled: boolean
  }
  interface WsPending {
    sid: number
    handlers: Array<(data: Uint8Array, isText: boolean) => void>
    queue: Array<{ data: Uint8Array; isText: boolean }>
    waiters: Array<(m: { data: Uint8Array; isText: boolean }) => void>
    closed: boolean
    bytesReceived: number
    // A real phone seals a cumulative Ack as it consumes daemon->phone Data (frame-mux recvFlow). The
    // fixture mirrors that so the daemon's sender window stays open for a fast reader. A noAck stream
    // models a slow/stalled phone (never acks) so the sender-window backpressure (VULN-RELIABILITY-1)
    // can be observed.
    recvFlow: FlowController
    noAck: boolean
  }
  const httpStreams = new Map<number, HttpPending>()
  const wsStreams = new Map<number, WsPending>()

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

  // Open an inbound daemon->phone frame and route the plaintext to the matching stream.
  const demuxInbound = (raw: Uint8Array): void => {
    if (!device) return
    const routed = unwrapRelayRoute(raw)
    if (routed.deviceId && routed.deviceId !== device.deviceId) return
    const frame = routed.frame
    let opened: ReturnType<DevicePeer['open']>
    try {
      opened = device.open(frame)
    } catch {
      // A frame the phone can't open (should not happen with a correct daemon) — ignore.
      return
    }
    // The UNSEALED daemon ConnSalt armed the connKeys (M6.1). Now seal + send the binding Hello on
    // CHANNEL_STREAM_ID at seq 0 under the fresh connKey — the daemon trial-opens it to bind us.
    if (opened.connSalt) {
      sendToDaemon(device.sealHello())
      return
    }
    const { header, plaintext } = opened
    const http = httpStreams.get(header.streamId)
    if (http) {
      if (header.kind === FrameKind.Reset) {
        if (!http.settled) {
          http.settled = true
          http.reject(new Error(`stream reset code=${decodeResetSafe(plaintext)}`))
        }
        httpStreams.delete(header.streamId)
        return
      }
      if (header.kind === FrameKind.Data) {
        const decoded = decodeHttpData(plaintext)
        if (decoded.kind === 'head') http.head = decoded.head
        else http.body.push(decoded.data)
        const fin = (header.flags & 0x0001) !== 0
        if (fin && !http.settled) finishHttp(header.streamId, http)
        return
      }
      if (header.kind === FrameKind.End) {
        if (!http.settled) finishHttp(header.streamId, http)
        return
      }
      return
    }
    const ws = wsStreams.get(header.streamId)
    if (ws) {
      if (header.kind === FrameKind.Reset || header.kind === FrameKind.End) {
        ws.closed = true
        return
      }
      if (header.kind === FrameKind.Data) {
        const msg = decodeWsMessage(plaintext)
        ws.bytesReceived += msg.data.length
        // Seal a cumulative Ack back to the daemon as a real phone would (unless this stream models a
        // slow phone). This keeps the daemon's daemon->phone sender window open for a fast reader.
        if (!ws.noAck && device) {
          const ack = ws.recvFlow.onConsume(msg.data.length)
          if (ack) {
            sendToDaemon(
              device.seal({
                kind: FrameKind.Ack,
                streamId: ws.sid,
                payload: encodeAckPayload(ack.ackCumulative),
              })
            )
          }
        }
        deliverWs(ws, msg.data, msg.isText)
      }
      return
    }
    // Ack/Ping on a channel/unknown stream — ignored by the fixture's flow model.
  }

  const finishHttp = (streamId: number, http: HttpPending): void => {
    http.settled = true
    httpStreams.delete(streamId)
    http.resolve({
      status: http.head?.status ?? 0,
      headers: http.head?.headers ?? [],
      body: concatBytes(http.body),
    })
  }

  const decodeResetSafe = (p: Uint8Array): ResetCode | -1 => {
    try {
      return decodeResetPayload(p)
    } catch {
      return -1
    }
  }

  const deliverWs = (ws: WsPending, data: Uint8Array, isText: boolean): void => {
    const waiter = ws.waiters.shift()
    if (waiter) {
      waiter({ data, isText })
      return
    }
    if (ws.handlers.length > 0) {
      for (const h of ws.handlers) h(data, isText)
      return
    }
    ws.queue.push({ data, isText })
  }

  const sendToDaemon = (frame: Uint8Array): void => {
    for (const s of sockets) {
      if (s.readyState === WebSocket.OPEN) s.send(frame)
    }
  }

  // Resolve once the phone has completed the M6.1 channel handshake (the daemon's ConnSalt arrived and
  // the connKeys are armed). openHttp/openWs must not seal a frame before this — the phone gates its
  // own fetch on connKeys, and a seal before the handshake throws. The salt RTT is sub-frame in
  // practice; this is a correctness backstop for the async network round-trip in the fixture.
  const whenArmed = async (timeoutMs = 4000): Promise<void> => {
    if (!device) return
    const start = Date.now()
    while (!device.armed()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for the phone channel handshake (connKeys not armed)')
      }
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  const onSocket = (socket: WebSocket): void => {
    connections += 1
    sockets.add(socket)
    // M6.1: a fresh daemon socket = a fresh connection. The phone begins its channel — draws a fresh
    // phoneConnSalt and sends it UNSEALED. The daemon (already armed with its own salt at attachSocket)
    // re-emits ConnSalt{daemon}; demuxInbound then derives the connKeys and sends the sealed Hello.
    if (device) {
      socket.send(device.beginChannel())
    }
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (!isBinary) {
        const text = raw.toString()
        if (text === HB_PING) {
          pings += 1
          if (autoPong) socket.send(HB_PONG)
          for (let i = pingWaiters.length - 1; i >= 0; i--) {
            const w = pingWaiters[i]
            if (w && pings >= w.need) {
              w.resolve()
              pingWaiters.splice(i, 1)
            }
          }
          return
        }
        // The daemon must not send other strings up; ignore (matches the opaque relay).
        return
      }
      lastBinary = new Uint8Array(raw as Buffer)
      demuxInbound(lastBinary)
    })
    socket.on('close', () => {
      sockets.delete(socket)
    })
    socket.on('error', () => {
      sockets.delete(socket)
    })
    for (const w of daemonWaiters.splice(0)) w()
  }

  const buildServer = (listenPort: number): Promise<WebSocketServer> =>
    new Promise<WebSocketServer>((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: listenPort,
        // Validate the daemon credential the way the gateway Worker does: the token rides
        // Sec-WebSocket-Protocol as `bearer.<token>`. A wrong/absent token rejects the upgrade,
        // which surfaces to the daemon as a non-101 (the real 401 path).
        verifyClient: (info: { req: IncomingMessage }) => {
          const proto = info.req.headers['sec-websocket-protocol']
          const value = Array.isArray(proto) ? proto.join(',') : proto
          lastProtocol = value
          if (!value) return false
          for (const part of value.split(',')) {
            const token = part.trim()
            if (token.startsWith('bearer.')) {
              return token.slice('bearer.'.length) === options.expectedToken
            }
          }
          return false
        },
      })
      server.on('connection', onSocket)
      server.on('listening', () => {
        const addr = server.address() as AddressInfo
        port = addr.port
        resolve(server)
      })
      server.on('error', reject)
    })

  wss = await buildServer(0)

  const closeServer = (server: WebSocketServer): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const s of sockets) {
        try {
          s.terminate()
        } catch {
          // already gone
        }
      }
      sockets.clear()
      server.close(() => resolve())
    })

  return {
    get url() {
      return `ws://127.0.0.1:${port}`
    },
    connectionCount: () => connections,
    lastDaemonProtocol: () => lastProtocol,
    pingCount: () => pings,
    waitForDaemon: (timeoutMs = 2000) =>
      new Promise<void>((resolve, reject) => {
        if (sockets.size > 0) {
          resolve()
          return
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for daemon')), timeoutMs)
        daemonWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
    waitForPings: (n, timeoutMs = 3000) =>
      new Promise<void>((resolve, reject) => {
        if (pings >= n) {
          resolve()
          return
        }
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${n} pings (saw ${pings})`)),
          timeoutMs
        )
        pingWaiters.push({
          need: n,
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
        })
      }),
    sendControl: (c) => {
      const frame = GW_CONTROL_PREFIX + JSON.stringify(c)
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN) s.send(frame)
      }
    },
    sendBinary: (data) => {
      for (const s of sockets) {
        if (s.readyState === WebSocket.OPEN) s.send(data)
      }
    },
    sendSealed: (frame) => sendToDaemon(frame),
    rehandshakeDevice: async () => {
      if (!device) throw new Error('rehandshakeDevice requires a device peer (pass options.device)')
      sendToDaemon(device.beginChannel())
      await whenArmed()
    },
    openHttp: async (req) => {
      if (!device) throw new Error('openHttp requires a device peer (pass options.device)')
      await whenArmed()
      const sid = device.nextStreamId()
      const hasBody = req.body !== undefined && req.body.length > 0
      const openFrame = device.seal({
        kind: FrameKind.Open,
        streamId: sid,
        payload: encodeOpenPayload({
          transport: StreamTransport.Http,
          http: {
            method: req.method,
            path: req.path,
            headers: req.headers ?? [],
            hasBody,
          },
        }),
      })
      const promise = new Promise<PhoneHttpResult>((resolve, reject) => {
        httpStreams.set(sid, { body: [], resolve, reject, settled: false })
      })
      sendToDaemon(openFrame)
      if (hasBody && req.body) {
        sendToDaemon(
          device.seal({
            kind: FrameKind.Data,
            streamId: sid,
            payload: encodeHttpBodyChunk(req.body),
          })
        )
      }
      // FIN: signal request body complete with an End frame.
      sendToDaemon(device.seal({ kind: FrameKind.End, streamId: sid, payload: new Uint8Array(0) }))
      return promise
    },
    openWs: async (req) => {
      if (!device) throw new Error('openWs requires a device peer (pass options.device)')
      await whenArmed()
      const sid = device.nextStreamId()
      const pending: WsPending = {
        sid,
        handlers: [],
        queue: [],
        waiters: [],
        closed: false,
        bytesReceived: 0,
        recvFlow: createFlowController(),
        noAck: req.noAck ?? false,
      }
      wsStreams.set(sid, pending)
      sendToDaemon(
        device.seal({
          kind: FrameKind.Open,
          streamId: sid,
          payload: encodeOpenPayload({
            transport: StreamTransport.Ws,
            ws: { path: req.path },
          }),
        })
      )
      const stream: PhoneWsStream = {
        send: (data, isText) => {
          sendToDaemon(
            device.seal({
              kind: FrameKind.Data,
              streamId: sid,
              payload: encodeWsMessage(data, isText),
            })
          )
        },
        onMessage: (cb) => {
          pending.handlers.push(cb)
          for (const m of pending.queue.splice(0)) cb(m.data, m.isText)
        },
        next: (timeoutMs = 3000) =>
          new Promise((resolve, reject) => {
            const queued = pending.queue.shift()
            if (queued) {
              resolve(queued)
              return
            }
            const timer = setTimeout(
              () => reject(new Error('timed out waiting for ws message')),
              timeoutMs
            )
            pending.waiters.push((m) => {
              clearTimeout(timer)
              resolve(m)
            })
          }),
        close: () => {
          sendToDaemon(
            device.seal({ kind: FrameKind.End, streamId: sid, payload: new Uint8Array(0) })
          )
        },
        closed: () => pending.closed,
        bytesReceived: () => pending.bytesReceived,
      }
      return stream
    },
    lastBinaryFromDaemon: () => lastBinary,
    dropDaemon: () => {
      for (const s of sockets) {
        try {
          s.terminate()
        } catch {
          // already gone
        }
      }
      sockets.clear()
    },
    stopListening: () => closeServer(wss),
    restart: async () => {
      wss = await buildServer(port)
    },
    close: () => closeServer(wss),
  }
}

export { RelayCloseCode }
