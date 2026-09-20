import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { type RawData, WebSocket, WebSocketServer } from 'ws'

import {
  CONN_SALT_STREAM_ID,
  createFlowController,
  decodeHttpData,
  decodeResetPayload,
  decodeWsMessage,
  encodeAckPayload,
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

// Local 12-byte header peek (streamId only) so the relay can route the UNSEALED ConnSalt by its
// cleartext streamId without trying to open it as a sealed frame.
const peekStreamId = (frame: Uint8Array): number =>
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4)

// A REAL `ws` gateway-relay stand-in that drives MORE THAN ONE phone over the SINGLE daemon socket —
// the real fan-in shape (one daemon, one outbound socket, N multiplexed phones). The shared
// fake-gateway.ts carries exactly one device peer; this fixture carries a set, demuxing each inbound
// daemon->phone frame to its owning phone by trial-opening with each peer's d2p (the same AEAD-resolves
// dance the daemon does inbound). It exists to exercise the M6 single-daemon multi-device concurrency
// goal + H-NET-4 (two devices legitimately allocate the same odd streamId): a frame for device B's
// stream 3 must not be black-holed by device A's stream 3.
//
// NOT a mock: it is a genuine 127.0.0.1 ws server the daemon's outbound socket actually connects to,
// and every frame is real M1-sealed ciphertext. Only the relay's account/auth bookkeeping is faked.

const HB_PING = 'hb:ping'
const HB_PONG = 'hb:pong'

export interface MultiDeviceHttpResult {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

interface HttpPending {
  head?: HttpResponseHead
  body: Uint8Array[]
  resolve: (r: MultiDeviceHttpResult) => void
  reject: (e: unknown) => void
  settled: boolean
}

interface WsPending {
  sid: number
  bytesReceived: number
  closed: boolean
  recvFlow: FlowController
  onData: Array<(data: Uint8Array, isText: boolean) => void>
}

// One phone's demux state + the seal/open handle, sharing the single daemon socket.
interface PhoneEndpoint {
  readonly peer: DevicePeer
  readonly http: Map<number, HttpPending>
  readonly ws: Map<number, WsPending>
}

export interface MultiDevicePhone {
  readonly deviceId: string
  /** Drive a full GET/POST over the tunnel for THIS phone. */
  http(req: {
    method: string
    path: string
    headers?: Array<[string, string]>
  }): Promise<MultiDeviceHttpResult>
  /** Open a WS stream for THIS phone; cb fires for each daemon->phone message. */
  ws(req: { path: string; onData: (data: Uint8Array, isText: boolean) => void }): {
    send: (data: Uint8Array, isText: boolean) => void
    closed: () => boolean
  }
}

export interface MultiDeviceGateway {
  readonly url: string
  waitForDaemon(timeoutMs?: number): Promise<void>
  /** Register a phone (its real M1 peer) onto the shared socket and return a driver. */
  addPhone(peer: DevicePeer): MultiDevicePhone
  close(): Promise<void>
}

export const startMultiDeviceGateway = async (opts: {
  expectedToken: string
}): Promise<MultiDeviceGateway> => {
  const sockets = new Set<WebSocket>()
  const phones: PhoneEndpoint[] = []
  const daemonWaiters: Array<() => void> = []
  let port = 0

  const concat = (chunks: Uint8Array[]): Uint8Array => {
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

  const decodeResetSafe = (p: Uint8Array): ResetCode | -1 => {
    try {
      return decodeResetPayload(p)
    } catch {
      return -1
    }
  }

  const sendToDaemon = (frame: Uint8Array): void => {
    for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.send(frame)
  }

  // Route one inbound daemon->phone frame. The UNSEALED daemon ConnSalt (M6.1, on CONN_SALT_STREAM_ID)
  // is broadcast to every phone on the socket. Sealed frames carry an HRT1 device-id prefix (same as
  // production RelayDO). Do NOT trial-open AEAD across phones — that hid the production broadcast bug.
  const demuxInbound = (raw: Uint8Array): void => {
    const routed = unwrapRelayRoute(raw)
    const frame = routed.frame
    if (peekStreamId(frame) === CONN_SALT_STREAM_ID) {
      // Feed the daemon ConnSalt to every phone that has begun its channel; each derives + replies. The
      // relay broadcasts the daemon salt to ALL phones, so a phone already armed under these exact
      // bytes must NOT send another Hello (its no-op re-key guard keeps armed() true but does not
      // re-arm). Only a phone that JUST transitioned unarmed→armed replies with its binding Hello.
      for (const ep of phones) {
        const wasArmed = ep.peer.armed()
        const res = ep.peer.open(frame)
        if (res.connSalt && !wasArmed && ep.peer.armed()) sendToDaemon(ep.peer.sealHello())
      }
      return
    }
    if (!routed.deviceId) return
    const ep = phones.find((p) => p.peer.deviceId === routed.deviceId)
    if (!ep?.peer.armed()) return
    let opened: ReturnType<DevicePeer['open']>
    try {
      opened = ep.peer.open(frame)
    } catch {
      return
    }
    if (opened.connSalt) return
    const { header, plaintext } = opened
    const http = ep.http.get(header.streamId)
    if (http) {
      if (header.kind === FrameKind.Reset) {
        if (!http.settled) {
          http.settled = true
          http.reject(new Error(`stream reset code=${decodeResetSafe(plaintext)}`))
        }
        ep.http.delete(header.streamId)
        return
      }
      if (header.kind === FrameKind.Data) {
        const decoded = decodeHttpData(plaintext)
        if (decoded.kind === 'head') http.head = decoded.head
        else http.body.push(decoded.data)
        if ((header.flags & 0x0001) !== 0 && !http.settled) finishHttp(ep, header.streamId, http)
        return
      }
      if (header.kind === FrameKind.End) {
        if (!http.settled) finishHttp(ep, header.streamId, http)
        return
      }
      return
    }
    const ws = ep.ws.get(header.streamId)
    if (ws) {
      if (header.kind === FrameKind.Reset || header.kind === FrameKind.End) {
        ws.closed = true
        return
      }
      if (header.kind === FrameKind.Data) {
        const msg = decodeWsMessage(plaintext)
        ws.bytesReceived += msg.data.length
        const ack = ws.recvFlow.onConsume(msg.data.length)
        if (ack) {
          sendToDaemon(
            ep.peer.seal({
              kind: FrameKind.Ack,
              streamId: ws.sid,
              payload: encodeAckPayload(ack.ackCumulative),
            })
          )
        }
        for (const cb of ws.onData) cb(msg.data, msg.isText)
      }
    }
  }

  const finishHttp = (ep: PhoneEndpoint, sid: number, http: HttpPending): void => {
    http.settled = true
    ep.http.delete(sid)
    http.resolve({
      status: http.head?.status ?? 0,
      headers: http.head?.headers ?? [],
      body: concat(http.body),
    })
  }

  const onSocket = (socket: WebSocket): void => {
    sockets.add(socket)
    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (!isBinary) {
        if (raw.toString() === HB_PING) socket.send(HB_PONG)
        return
      }
      demuxInbound(new Uint8Array(raw as Buffer))
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    for (const w of daemonWaiters.splice(0)) w()
  }

  const wss = await new Promise<WebSocketServer>((resolve, reject) => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (info: { req: IncomingMessage }) => {
        const proto = info.req.headers['sec-websocket-protocol']
        const value = Array.isArray(proto) ? proto.join(',') : proto
        if (!value) return false
        for (const part of value.split(',')) {
          const token = part.trim()
          if (token.startsWith('bearer.'))
            return token.slice('bearer.'.length) === opts.expectedToken
        }
        return false
      },
    })
    server.on('connection', onSocket)
    server.on('listening', () => {
      port = (server.address() as AddressInfo).port
      resolve(server)
    })
    server.on('error', reject)
  })

  return {
    get url() {
      return `ws://127.0.0.1:${port}`
    },
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
    addPhone: (peer) => {
      const ep: PhoneEndpoint = { peer, http: new Map(), ws: new Map() }
      phones.push(ep)
      // M6.1: begin this phone's channel — send the UNSEALED device ConnSalt. The daemon (already
      // armed at attachSocket) re-emits its ConnSalt on observing a NEW phone, which demuxInbound
      // routes back to derive THIS phone's connKeys + send its sealed Hello.
      sendToDaemon(peer.beginChannel())
      const whenArmed = async (timeoutMs = 4000): Promise<void> => {
        const start = Date.now()
        while (!peer.armed()) {
          if (Date.now() - start > timeoutMs) {
            throw new Error(`phone ${peer.deviceId} channel handshake did not arm`)
          }
          await new Promise((r) => setTimeout(r, 5))
        }
      }
      return {
        deviceId: peer.deviceId,
        http: async (req) => {
          await whenArmed()
          const sid = peer.nextStreamId()
          const openFrame = peer.seal({
            kind: FrameKind.Open,
            streamId: sid,
            payload: encodeOpenPayload({
              transport: StreamTransport.Http,
              http: {
                method: req.method,
                path: req.path,
                headers: req.headers ?? [],
                hasBody: false,
              },
            }),
          })
          const promise = new Promise<MultiDeviceHttpResult>((resolve, reject) => {
            ep.http.set(sid, { body: [], resolve, reject, settled: false })
          })
          sendToDaemon(openFrame)
          sendToDaemon(
            peer.seal({ kind: FrameKind.End, streamId: sid, payload: new Uint8Array(0) })
          )
          return promise
        },
        ws: (req) => {
          const pending: WsPending = {
            sid: -1,
            bytesReceived: 0,
            closed: false,
            recvFlow: createFlowController(),
            onData: [req.onData],
          }
          // The handshake is async; allocate the stream id + send the Open once armed. send() before
          // the open is queued behind the same arm gate so frame order is preserved.
          const ready = whenArmed().then(() => {
            const sid = peer.nextStreamId()
            pending.sid = sid
            ep.ws.set(sid, pending)
            sendToDaemon(
              peer.seal({
                kind: FrameKind.Open,
                streamId: sid,
                payload: encodeOpenPayload({
                  transport: StreamTransport.Ws,
                  ws: { path: req.path },
                }),
              })
            )
          })
          return {
            send: (data, isText) => {
              void ready.then(() =>
                sendToDaemon(
                  peer.seal({
                    kind: FrameKind.Data,
                    streamId: pending.sid,
                    payload: encodeWsMessage(data, isText),
                  })
                )
              )
            },
            closed: () => pending.closed,
          }
        },
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          try {
            s.terminate()
          } catch {
            // already gone
          }
        }
        sockets.clear()
        wss.close(() => resolve())
      }),
  }
}
