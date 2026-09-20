// The phone's device WS to the gateway: wss://<gateway>/relay?daemonId=<id>, bearer.<phoneJwt> in
// Sec-WebSocket-Protocol (matching the daemon's bearerFromProtocol). It splits the wire into two
// bands: control strings (\x00gw: + JSON — peer presence / revoked / error, parsed not bridged) and
// opaque binary (the E2E mux frames). It owns reconnect+backoff, the app-level heartbeat, and the
// auth-fatal latch.
//
// Auth-fatal vs transient (HARDEN):
//   - 4401 Unauthorized / 4410 Revoked WS close, or a 'revoked' control frame -> LATCH revoked, no retry.
//   - a NON-101 upgrade (the gateway answers the /relay upgrade with 401/403, surfaced here as a close
//     BEFORE the socket ever opened with a 4xxx/403 code) -> also LATCH revoked. Without this a device
//     revoked WHILE in a 4404 backoff would 403 every reconnect upgrade and loop forever.
//   - 1006 / 4404 DaemonOffline / 4409 Replaced -> transient: backoff + retry on the same URL.

import {
  type GatewayControl,
  GW_CONTROL_PREFIX,
  HB_PING,
  HB_PONG,
  isAuthFatalCloseCode,
  RelayCloseCode,
} from '../../../src/server/remote-control-constants.js'

export interface RelaySocketDeps {
  gatewayUrl: string
  daemonId: string
  phoneSessionToken: string
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
  backoff?: { next(): number; reset(): void }
  /** ms between heartbeat pings (the DO auto-pongs without waking). */
  heartbeatMs?: number
  /**
   * ms to wait for an hb:pong before declaring the socket dead (H-NET-1). Mirrors the daemon's
   * DEFAULT_HB_DEADLINE_MS. On a half-open socket the send succeeds into the void; without this
   * deadline the phone only learns it died via TCP timeout (minutes on mobile) and in-flight fetches
   * hang far longer than they should.
   */
  heartbeatDeadlineMs?: number
  /**
   * Max CONSECUTIVE 4404 DaemonOffline reconnect attempts before giving up the auto-retry loop
   * (H-NET-2). Without a ceiling the phone retries the same /relay?daemonId= URL forever while the
   * daemon is down (~1 upgrade/15-30s indefinitely). After the cap the relay surfaces a TERMINAL
   * daemonOffline onDown (no nextRetryInMs) and stops; resume() restarts it on user action. A
   * successful open resets the counter.
   */
  maxOfflineRetries?: number
}

export interface RelaySocketCallbacks {
  onFrame: (frame: Uint8Array) => void
  onControl: (c: GatewayControl) => void
  onUp: () => void
  /**
   * authFatal => latch; the caller must NOT keep the socket retrying.
   * daemonOffline => the H-NET-2 cap was hit: no retry is armed (no nextRetryInMs); the daemon is
   *   offline and the user can resume() to try again. Distinct from authFatal (the credential is fine).
   */
  onDown: (info: {
    code: number
    authFatal: boolean
    nextRetryInMs?: number
    daemonOffline?: boolean
  }) => void
}

export interface RelaySocket {
  send(frame: Uint8Array): void
  /** Bytes queued in the underlying WebSocket's send buffer; 0 when no socket is open. */
  bufferedAmount(): number
  isOpen(): boolean
  /** Restart the connect loop after a terminal daemonOffline give-up (H-NET-2). No-op if disposed. */
  resume(): void
  close(): void
}

const DEFAULT_HEARTBEAT_MS = 20_000
const DEFAULT_HEARTBEAT_DEADLINE_MS = 10_000
const DEFAULT_MAX_OFFLINE_RETRIES = 6

const defaultBackoff = () => {
  let attempt = 0
  return {
    next(): number {
      attempt += 1
      const base = Math.min(30_000, 500 * 2 ** (attempt - 1))
      // full jitter so a fleet doesn't reconnect in lockstep
      return Math.floor(base / 2 + Math.random() * (base / 2))
    },
    reset(): void {
      attempt = 0
    },
  }
}

// A close BEFORE the socket opened with a 4403 (Forbidden) means the gateway rejected the relay
// upgrade for this device — treat it like 401/403, not a transient blip.
const isUpgradeAuthFatal = (code: number, everOpened: boolean): boolean =>
  !everOpened && (code === RelayCloseCode.Forbidden || code === RelayCloseCode.Unauthorized)

export const createRelaySocket = (
  deps: RelaySocketDeps,
  cbs: RelaySocketCallbacks
): RelaySocket => {
  const WS = deps.WebSocketImpl ?? WebSocket
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  const backoff = deps.backoff ?? defaultBackoff()
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const heartbeatDeadlineMs = deps.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS
  const maxOfflineRetries = deps.maxOfflineRetries ?? DEFAULT_MAX_OFFLINE_RETRIES

  let socket: WebSocket | null = null
  let generation = 0
  let latched = false
  let disposed = false
  // Set once the H-NET-2 cap is hit: the auto-retry loop has given up; resume() clears it.
  let offlineGaveUp = false
  // Consecutive 4404 DaemonOffline closes since the last successful open. Reset on onUp.
  let consecutiveOffline = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  const url = `${deps.gatewayUrl}/relay?daemonId=${encodeURIComponent(deps.daemonId)}`

  const clearPongDeadline = (): void => {
    if (pongDeadlineTimer !== null) {
      clearTimer(pongDeadlineTimer)
      pongDeadlineTimer = null
    }
  }

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    clearPongDeadline()
  }

  const startHeartbeat = (s: WebSocket, gen: number): void => {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (s.readyState === s.OPEN) {
        try {
          s.send(HB_PING)
        } catch {
          // socket dying; the close handler will drive reconnect
        }
        // Arm a deadline on the OLDEST unanswered ping (H-NET-1, mirrors remote-tunnel.ts). A pong
        // clears it; the next pong-cleared interval re-arms a fresh one. We do NOT reset it on each
        // ping — otherwise an interval shorter than the deadline would mask a dead socket forever.
        if (pongDeadlineTimer === null) {
          pongDeadlineTimer = setTimer(() => {
            pongDeadlineTimer = null
            if (gen !== generation || disposed) return
            // No hb:pong in time: the socket is (half-)open into the void. Force-close so onclose
            // drives the transient reconnect path instead of hanging on TCP timeout.
            stopHeartbeat()
            try {
              s.close()
            } catch {
              // already gone; onclose still recovers
            }
          }, heartbeatDeadlineMs)
        }
      }
    }, heartbeatMs)
  }

  const connect = (): void => {
    if (disposed || latched || offlineGaveUp) return
    const myGen = ++generation
    let everOpened = false
    const s = new WS(url, [`bearer.${deps.phoneSessionToken}`])
    s.binaryType = 'arraybuffer'
    socket = s

    s.onopen = () => {
      if (myGen !== generation || disposed) return
      everOpened = true
      backoff.reset()
      consecutiveOffline = 0
      startHeartbeat(s, myGen)
      cbs.onUp()
    }

    s.onmessage = (ev: MessageEvent) => {
      if (myGen !== generation || disposed) return
      const data = ev.data
      if (typeof data === 'string') {
        if (data.startsWith(GW_CONTROL_PREFIX)) {
          let control: GatewayControl
          try {
            control = JSON.parse(data.slice(GW_CONTROL_PREFIX.length)) as GatewayControl
          } catch {
            return
          }
          if (control.t === 'revoked') {
            latch(RelayCloseCode.Revoked)
            cbs.onControl(control)
            return
          }
          cbs.onControl(control)
          return
        }
        // hb:pong answers the oldest unanswered ping — clear the deadline (H-NET-1). The next
        // pong-cleared interval re-arms a fresh one. Any other non-control string is ignored.
        if (data === HB_PONG) clearPongDeadline()
        return
      }
      const bytes =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBufferLike)
      cbs.onFrame(bytes)
    }

    s.onerror = () => {
      // surfaced as a close right after; nothing to do here
    }

    s.onclose = (ev: CloseEvent) => {
      if (myGen !== generation || disposed) return
      stopHeartbeat()
      socket = null
      const code = ev.code ?? RelayCloseCode.InternalError
      if (isAuthFatalCloseCode(code) || isUpgradeAuthFatal(code, everOpened)) {
        latch(code)
        return
      }
      // H-NET-2: a 4404 DaemonOffline close (the daemon is down) is transient, but retrying the same
      // URL forever is an indefinite open-upgrade loop. Count consecutive 4404s; past the cap, give up
      // the auto-retry and surface a TERMINAL daemonOffline onDown (no nextRetryInMs). The user can
      // resume() to try again. Any non-4404 transient close resets the counter (the daemon may be up).
      if (code === RelayCloseCode.DaemonOffline) {
        consecutiveOffline += 1
        if (consecutiveOffline >= maxOfflineRetries) {
          offlineGaveUp = true
          cbs.onDown({ code, authFatal: false, daemonOffline: true })
          return
        }
      } else {
        consecutiveOffline = 0
      }
      // transient: schedule a backed-off reconnect
      const delay = backoff.next()
      cbs.onDown({ code, authFatal: false, nextRetryInMs: delay })
      reconnectTimer = setTimer(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }
  }

  const latch = (code: number): void => {
    if (latched) return
    latched = true
    stopHeartbeat()
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
    cbs.onDown({ code, authFatal: true })
  }

  // On mobile, backgrounding suspends timers and the OS may silently drop the TCP connection. When
  // the tab becomes visible again (or the device regains network), nudge an immediate reconnect
  // rather than waiting for the next backed-off timer or the heartbeat deadline.
  const nudgeReconnect = (): void => {
    if (disposed || latched || offlineGaveUp) return
    if (
      socket !== null &&
      (socket.readyState === socket.OPEN || socket.readyState === WebSocket.CONNECTING)
    )
      return
    // Cancel any pending backoff timer and reconnect immediately (the socket is already gone).
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
    connect()
  }

  const onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') nudgeReconnect()
  }
  const onOnline = (): void => nudgeReconnect()

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
  }

  connect()

  return {
    send(frame) {
      if (socket && socket.readyState === socket.OPEN) socket.send(frame)
    },
    bufferedAmount: () => (socket && socket.readyState === socket.OPEN ? socket.bufferedAmount : 0),
    isOpen: () => socket !== null && socket.readyState === socket.OPEN,
    resume() {
      // User-driven retry after the H-NET-2 give-up. No-op if disposed/latched or already connecting.
      if (disposed || latched || !offlineGaveUp) return
      offlineGaveUp = false
      consecutiveOffline = 0
      backoff.reset()
      connect()
    },
    close() {
      disposed = true
      generation += 1
      stopHeartbeat()
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer)
        reconnectTimer = null
      }
      if (socket) {
        try {
          socket.close()
        } catch {
          // already gone
        }
        socket = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
      }
    },
  }
}
