// TunnelTransport — the mobile half of the ApiTransport seam. The SAME web app code (api.ts.apiFetch,
// terminal-client, useTasksFile) rides this instead of DirectTransport when the bundle is gateway-served.
//
// It does NOT touch the gateway origin: every fetch('/api/*') and new WebSocket('/ws/*') is framed
// (M1 remote-protocol), sealed (M1 remote-crypto device session), and relayed over the gateway device
// WS to the user's daemon, which bridges them to its local runtime. The gateway sees only ciphertext.
//
// Responsibilities here:
//   - construct the relay socket + the phone-side mux from the device session keys
//   - bind the device with a channel Hello before any stream
//   - surface ConnectionStatus (connecting/online/reconnecting/disconnected/revoked) for the banner
//   - on disconnect, fail in-flight streams fast (no hang) and on auth-fatal latch revoked
//
// NO UI cookie / cookie jar: the desktop browser authenticates /api/* with the hive_ui_token cookie
// the daemon's /api/ui/session sets same-origin. The tunnel does NOT use that token at all — tunnel
// /api/* is authorized by the daemon's per-boot internal secret, which the bridge stamps on every
// loopback request (requireUiTokenFromRequest short-circuits on it), and /api/ui/session is HARD-DENIED
// to tunnel-tagged requests at both the bridge whitelist and the route. So the phone never holds the UI
// token, there is nothing to replay, and the api.ts 403-refresh path is a desktop-only concern (it can
// never fire on the tunnel because the per-boot-secret auth never returns the "valid UI token" 403).

import type {
  ApiTransport,
  ConnectionState,
  ConnectionStatus,
  TransportSocket,
} from './api-transport.js'
import { createFrameMux, type FrameMux } from './frame-mux.js'
import { createRelaySocket, type RelaySocket } from './relay-socket.js'

export interface TunnelSession {
  /** persisted directional ROOT keys (M6.1) — never an AEAD key directly; the mux derives a fresh
   *  per-connection key from these + a bilateral salt every (re)connect. phone SEALS p2d, OPENS d2p. */
  roots: { d2p: Uint8Array; p2d: Uint8Array }
  deviceId: string
  daemonId: string
  /** wss://app.hivehq.dev */
  gatewayUrl: string
  /** device-bound gateway JWT (did=deviceId); rides Sec-WebSocket-Protocol */
  phoneSessionToken: string
}

export interface TunnelTransportDeps {
  session?: TunnelSession
  onStatus: (s: ConnectionStatus) => void
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  backoff?: { next(): number; reset(): void }
  /** for silent rebuild on page refresh — used when `session` is absent. */
  persistedSession?: () => TunnelSession | null
}

export interface TunnelTransport extends ApiTransport {
  status(): ConnectionStatus
  ready(options?: { timeoutMs?: number }): Promise<void>
  dispose(): void
}

interface ReadyWaiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export function createTunnelTransport(deps: TunnelTransportDeps): TunnelTransport {
  const session = deps.session ?? deps.persistedSession?.() ?? null
  if (!session) {
    throw new Error('createTunnelTransport: no session and persistedSession() returned null')
  }

  let status: ConnectionStatus = { state: 'connecting' }
  const emit = (
    state: ConnectionState,
    extra?: { reason?: string; nextRetryInMs?: number; retry?: () => void }
  ): void => {
    status = {
      state,
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.nextRetryInMs !== undefined ? { nextRetryInMs: extra.nextRetryInMs } : {}),
      ...(extra?.retry ? { retry: extra.retry } : {}),
    }
    deps.onStatus(status)
  }

  let relay: RelaySocket | null = null
  let ready = false
  let daemonPeerOffline = false
  let channelOpening = false
  const readyWaiters = new Set<ReadyWaiter>()
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

  const resolveReadyWaiters = (): void => {
    for (const waiter of readyWaiters) {
      if (waiter.timer !== null) clearTimer(waiter.timer)
      waiter.resolve()
    }
    readyWaiters.clear()
  }

  const rejectReadyWaiters = (reason: string): void => {
    for (const waiter of readyWaiters) {
      if (waiter.timer !== null) clearTimer(waiter.timer)
      waiter.reject(new Error(`tunnel: ${reason}`))
    }
    readyWaiters.clear()
  }

  const markNotReady = (): void => {
    ready = false
  }

  const markReady = (): void => {
    if (ready) return
    channelOpening = false
    daemonPeerOffline = false
    ready = true
    emit('online')
    resolveReadyWaiters()
  }

  const beginChannel = (): void => {
    channelOpening = true
    ready = false
    mux.beginChannel()
  }

  // Multi-chunk upload pacing: hold the mux's body loop while the relay socket's send buffer is
  // above the high-water mark, so a 100MB evidence upload streams through ~4MiB of buffer instead of
  // being mirrored wholesale into WebSocket memory. A closed socket reports 0 buffered, so the loop
  // never spins on a dead connection — the resetAll() from onDown settles the stream and stops it.
  const BODY_DRAIN_HIGH_WATER_BYTES = 4 * 1024 * 1024
  const BODY_DRAIN_POLL_MS = 50
  const awaitRelayDrain = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (!relay || relay.bufferedAmount() <= BODY_DRAIN_HIGH_WATER_BYTES) {
          resolve()
          return
        }
        setTimer(poll, BODY_DRAIN_POLL_MS)
      }
      poll()
    })

  const mux: FrameMux = createFrameMux({
    roots: session.roots,
    daemonId: session.daemonId,
    deviceId: session.deviceId,
    send: (frame) => relay?.send(frame),
    onReady: markReady,
    awaitDrain: awaitRelayDrain,
  })

  relay = createRelaySocket(
    {
      gatewayUrl: session.gatewayUrl,
      daemonId: session.daemonId,
      phoneSessionToken: session.phoneSessionToken,
      ...(deps.WebSocketImpl ? { WebSocketImpl: deps.WebSocketImpl } : {}),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
      ...(deps.backoff ? { backoff: deps.backoff } : {}),
    },
    {
      onFrame: (frame) => {
        try {
          mux.onFrame(frame)
        } catch (error) {
          // A frame sealed for another device (or otherwise unopenable) must not kill this phone.
          // mux.onFrame already drops openNext failures; this catch is defense if decode throws.
          console.warn('[hive] dropped unopenable relay frame', error)
        }
      },
      onControl: (control) => {
        if (control.t === 'peer-offline' && control.role === 'daemon') {
          // the daemon dropped its streams; fail in-flight fast and show reconnecting (no hang)
          daemonPeerOffline = true
          channelOpening = false
          markNotReady()
          mux.resetAll('peer_offline')
          emit('reconnecting')
        } else if (control.t === 'peer-online' && control.role === 'daemon') {
          // A daemon-online control can be delivered more than once (or race with socket onUp). Treat
          // it as a re-arm only after an observed daemon-offline; otherwise an already-good channel
          // must not rewind its salt/seq and desync the daemon bridge.
          if (ready || channelOpening) return
          if (!daemonPeerOffline) return
          daemonPeerOffline = false
          beginChannel()
        } else if (control.t === 'revoked') {
          daemonPeerOffline = false
          channelOpening = false
          markNotReady()
          mux.resetAll('revoked')
          rejectReadyWaiters(control.reason ?? 'revoked')
          emit('revoked', { reason: control.reason })
        }
      },
      onUp: () => {
        // begin the connection: draw a fresh phoneConnSalt and send the unsealed ConnSalt. The sealed
        // Hello + any queued stream traffic wait on the daemon's salt (sub-frame RTT, no new async).
        daemonPeerOffline = false
        beginChannel()
      },
      onDown: (info) => {
        daemonPeerOffline = false
        channelOpening = false
        markNotReady()
        mux.resetAll(
          info.authFatal ? 'auth_fatal' : info.daemonOffline ? 'daemon_offline' : 'transient'
        )
        if (info.authFatal) {
          rejectReadyWaiters('auth_fatal')
          emit('revoked')
        } else if (info.daemonOffline) {
          // H-NET-2: the relay gave up after the 4404 cap. Surface a TERMINAL disconnected state (no
          // retry hint) instead of a perpetual 'reconnecting'. The relay is resumable on user action.
          rejectReadyWaiters('daemon_offline')
          emit('disconnected', { reason: 'daemon_offline', retry: () => relay?.resume() })
        } else {
          emit(
            'reconnecting',
            info.nextRetryInMs !== undefined ? { nextRetryInMs: info.nextRetryInMs } : undefined
          )
        }
      },
    }
  )

  return {
    requiresUiSession: false,
    fetch: (path, init): Promise<Response> => mux.fetch(path, init),
    openWebSocket: (path, params): TransportSocket => mux.openWebSocket(path, params),
    status: () => status,
    ready: (options = {}): Promise<void> => {
      if (ready) return Promise.resolve()
      const timeoutMs = options.timeoutMs ?? 10_000
      return new Promise<void>((resolve, reject) => {
        const waiter: ReadyWaiter = { resolve, reject, timer: null }
        waiter.timer = setTimer(() => {
          readyWaiters.delete(waiter)
          reject(new Error('tunnel: channel ready timed out'))
        }, timeoutMs)
        readyWaiters.add(waiter)
      })
    },
    dispose: () => {
      daemonPeerOffline = false
      channelOpening = false
      markNotReady()
      relay?.close()
      relay = null
      mux.resetAll('disposed')
      rejectReadyWaiters('disposed')
    },
  }
}
