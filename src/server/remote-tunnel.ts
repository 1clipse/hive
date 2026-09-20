// Daemon-side remote tunnel — the OUTBOUND WebSocket controller.
//
// When remote access is ENABLED and the daemon is logged in, the runtime keeps a single outbound
// socket to the gateway relay (`wss://<gatewayUrl>/relay/daemon`, presenting `bearer.<daemonToken>`
// in Sec-WebSocket-Protocol — the exact M2 contract in gateway/src/relay-do.ts). After the 101 the
// socket carries:
//   - opaque binary E2E frames (phone↔daemon, M1 crypto) — handed verbatim to the bridge
//   - a thin string control band (sentinel-prefixed JSON) the gateway originates (peer presence,
//     revocation) plus the 'hb:ping'/'hb:pong' keepalive
//
// THIS FILE owns the SOCKET LIFECYCLE: connect, exponential-backoff reconnect, heartbeat, status
// reporting, revoke latch, clean shutdown, and a generation guard so a zombie socket can never write
// onto a fresh one. The frame BRIDGE (E2E open/seal, mux demux, loopback request/ws) is a separate
// concern injected via `createBridge`; the controller only moves opaque bytes between the socket and
// `bridge.onInbound` / the outbound sink the bridge gets from `attachSocket`.
//
// SECURITY INVARIANTS enforced here:
//   3. Revocation: a gateway `revoked` control frame, a 4401/4410 close, or local revokeAndStop()
//      tears the socket + all bridge streams down immediately and LATCHES — no reconnect until
//      refresh() re-reads config.
//   4. Off = zero behavior change: refresh() with remote_enabled !== 'true' settles 'disabled'
//      SYNCHRONOUSLY — WebSocketImpl is never invoked, no timer is scheduled, no listener is added.

import type WebSocket from 'ws'
import { WebSocket as NodeWebSocket } from 'ws'

import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteConfigSource } from './remote-config-keys.js'
import {
  type GatewayControl,
  GW_CONTROL_PREFIX,
  HB_PING,
  HB_PONG,
  isAuthFatalCloseCode,
} from './remote-control-constants.js'
import type { DeviceSessionProvider } from './remote-device-session.js'
import type { RemoteDeviceRecord } from './remote-device-store.js'
import { createFrameBridge, type FrameBridgeContext } from './remote-frame-bridge.js'
import { postPairConfirm } from './remote-gateway-client.js'
import type { RemotePairing } from './remote-pairing.js'
import {
  createRemotePairingTunnel,
  type RemotePairingTunnel,
  type RemotePairingTunnelDeps,
} from './remote-pairing-tunnel.js'

export type {
  FrameBridge as RemoteFrameBridge,
  FrameBridgeContext,
  LoopbackTransports,
} from './remote-frame-bridge.js'
// Re-export so the bridge stage's consumers (and tests) can import the E2E/mux bridge from the
// tunnel module — it is the bridge the controller pumps opaque bytes through.
export { createFrameBridge } from './remote-frame-bridge.js'

export type TunnelStatus =
  | 'disabled' // remote_enabled !== 'true' — terminal, no socket, no timers (invariant 4)
  | 'loggedOut' // enabled but no daemon token in app_state
  | 'connecting'
  | 'online'
  | 'reconnecting' // transient drop; backoff armed
  | 'revoked' // gateway/local revoke OR 4401/4410 — terminal, NO retry until refresh()

export interface TunnelStatusEvent {
  status: TunnelStatus
  reason?: string
  /** Monotonic; the UI ignores out-of-order late events from a stale generation. */
  generation: number
  /** Present in 'reconnecting'. */
  nextRetryInMs?: number
  /** 'online' only. */
  gatewayUrl?: string
}

// Exponential-backoff-with-jitter policy. Injectable so tests drive timing deterministically.
export interface BackoffPolicy {
  next(): number
  reset(): void
}

// The frame bridge seam (E2E + loopback). The controller is agnostic to its internals — it only
// pumps opaque bytes. M3's bridge stage supplies the real createFrameBridge; the lifecycle tests
// inject a no-op/observing one.
export interface FrameBridge {
  /** Wire the per-device opener/sealer + the outbound sink onto a freshly-opened socket. */
  attachSocket(send: (frame: Uint8Array) => void): void
  /** An opaque binary frame arrived from the gateway. */
  onInbound(frame: ArrayBuffer): void
  /**
   * Tear down every in-flight stream. Socket-teardown paths (socket down / revoke / shutdown) call
   * it without opts so the outbound sink is nulled too. The 'peer-offline' path passes
   * `{ keepSink: true }`: the daemon socket stays up, so the streams are reset but the sink must
   * survive for the phone to re-establish streams after 'peer-online'.
   */
  resetAllStreams(reason: string, opts?: { keepSink?: boolean }): void
  /** Close one device's in-flight streams (M4 revoke closed loop). Other devices + the sink survive. */
  closeDevice(deviceId: string, reason: string): void
}

export interface RemoteTunnelDeps {
  /** Bound loopback port (passed post-listen). The bridge bridges to 127.0.0.1:<port>. */
  loopbackPort: number
  config: RemoteConfigSource
  deviceSessions: DeviceSessionProvider
  /** Per-boot internal secret (store.getRemoteTunnelSecret()); stamped onto loopback requests. */
  loopbackSecret: string
  audit: RemoteAuditStore
  onStatus: (e: TunnelStatusEvent) => void
  /**
   * The daemon pairing engine. The tunnel carries pairing TEXT frames (phone↔daemon over the relay)
   * alongside the binary data plane and drives the daemon handshake half + the desktop-confirm
   * sequence through the pairing-tunnel driver. Optional so lifecycle/bridge tests that don't pair
   * can omit it (pairing frames are then ignored).
   */
  pairing?: RemotePairing

  // ── seams (real impls by default; overridden in tests) ──
  WebSocketImpl?: typeof WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (h: NodeJS.Timeout) => void
  backoff?: BackoffPolicy
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  /** Build the per-socket bridge. Defaults to a no-op (lifecycle-only); the bridge stage wires E2E. */
  createBridge?: (ctx: BridgeContext) => FrameBridge
  /** Build the pairing-tunnel driver. Defaults to the real createRemotePairingTunnel; tests inject. */
  createPairingTunnel?: (deps: RemotePairingTunnelDeps) => RemotePairingTunnel
  /** D5 seam: POST /pair/confirm. Defaults to the real gateway client. */
  postPairConfirm?: RemotePairingTunnelDeps['postPairConfirm']
}

export interface BridgeContext {
  loopbackPort: number
  loopbackSecret: string
  deviceSessions: DeviceSessionProvider
  audit: RemoteAuditStore
  /**
   * The daemon's own id (M6.1). Bound into the per-connection HKDF info, so it MUST equal the value
   * the phone stored in its HandshakeIds.daemonId — a mismatch diverges the info strings and EVERY
   * Hello fails to open. Sourced from config.getDaemonId() at socket-open time (guarded non-null).
   */
  daemonId: string
  /** Seam: deterministic-but-distinct daemon salts for tests. Defaults to the crypto export. */
  generateConnSalt?: () => Uint8Array
  /** Observation hook for the no-reuse / no-downgrade invariant (NOT a mock). */
  onSeal?: FrameBridgeContext['onSeal']
}

export interface RemoteTunnel {
  status(): TunnelStatus
  /** Reconcile desired (config) vs actual (socket). Idempotent; clears the revoked latch. */
  refresh(): void
  /** Authoritative kill: latch revoked, drop everything, no reconnect until refresh(). */
  revokeAndStop(reason: string): void
  /**
   * Close ONE device's live streams (M4 revoke closed loop). No-op-safe when no bridge is attached
   * (disabled/offline) — the persistent provider's revoke still rejects any NEW frame, so this is the
   * best-effort liveness half that tears down an already-open stream the instant the device is revoked.
   */
  closeDevice(deviceId: string, reason: string): void
  /**
   * Desktop-confirm a pairing (the trust-root route delegates here, plan step 4 / D3): insert the
   * local device row (engine), POST /pair/confirm to the gateway, then send `confirmed` to the phone
   * over the tunnel. Returns the local device record (null if the engine wouldn't confirm). Rejects
   * if the gateway POST fails or the boundJti is missing — the route surfaces it and the phone is NOT
   * told confirmed. No-op-safe (returns null) when the tunnel was built without a pairing engine.
   */
  confirmPairing(pairingId: string, name?: string): Promise<RemoteDeviceRecord | null>
  /** Graceful teardown (Ctrl+C). No status churn, no reconnect. */
  close(): Promise<void>
}

const DEFAULT_HB_INTERVAL_MS = 20_000
const DEFAULT_HB_DEADLINE_MS = 10_000
const CLOSE_GRACE_MS = 1_000

const createDefaultBackoff = (): BackoffPolicy => {
  const base = 500
  const factor = 2
  const cap = 30_000
  let attempt = 0
  return {
    next() {
      const exp = Math.min(cap, base * factor ** attempt)
      attempt += 1
      // full jitter: a random point in [0, exp]
      return Math.floor(Math.random() * exp)
    },
    reset() {
      attempt = 0
    },
  }
}

// Build the gateway relay URL. wss:// in prod; ws:// is allowed ONLY for a loopback host so the
// in-process fake-gateway fixture works without weakening production (a non-loopback ws:// is a
// downgrade and is rejected).
export const relayDaemonUrl = (gatewayUrl: string): string => {
  const u = new URL(gatewayUrl)
  if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol === 'http:') u.protocol = 'ws:'
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
    throw new Error(`unsupported gateway protocol: ${u.protocol}`)
  }
  // Numeric loopback literals ONLY — never the 'localhost' hostname. On Windows 'localhost' resolves
  // via the resolver / hosts file (commonly ::1 first, or remapped on locked-down machines), so an
  // insecure ws:// downgrade keyed on a hostname is not a guaranteed loopback. The IP literal is.
  // URL.hostname keeps the brackets on an IPv6 literal ('[::1]'), so match that form too.
  const isLoopback = u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]'
  if (u.protocol === 'ws:' && !isLoopback) {
    throw new Error('insecure ws:// gateway is only allowed for a numeric loopback host')
  }
  // join, tolerating a trailing slash on the configured base
  const base = u.toString().replace(/\/+$/, '')
  return `${base}/relay/daemon`
}

const toArrayBuffer = (data: Buffer | ArrayBuffer | Buffer[]): ArrayBuffer => {
  if (data instanceof ArrayBuffer) return data
  const buf = Array.isArray(data) ? Buffer.concat(data) : data
  // Copy into a freshly-owned ArrayBuffer: buf.buffer may be a pooled/SharedArrayBuffer and the
  // bridge keeps the bytes past this call, so a view-slice would risk aliasing the next frame.
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

export const createRemoteTunnel = (deps: RemoteTunnelDeps): RemoteTunnel => {
  const WebSocketImpl = deps.WebSocketImpl ?? NodeWebSocket
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  const backoff = deps.backoff ?? createDefaultBackoff()
  const hbInterval = deps.heartbeatIntervalMs ?? DEFAULT_HB_INTERVAL_MS
  const hbDeadline = deps.heartbeatDeadlineMs ?? DEFAULT_HB_DEADLINE_MS
  // Default to the real E2E/mux bridge; lifecycle tests inject a no-op/observing bridge to isolate
  // the socket FSM. The controller only pumps opaque bytes either way. The FrameBridgeContext is built
  // explicitly (only attaching the optional seams when present) so exactOptionalPropertyTypes stays
  // happy — BridgeContext is the controller's view; createFrameBridge wants the full bridge context.
  const createBridge =
    deps.createBridge ??
    ((ctx: BridgeContext) => {
      const fctx: FrameBridgeContext = {
        loopbackPort: ctx.loopbackPort,
        loopbackSecret: ctx.loopbackSecret,
        deviceSessions: ctx.deviceSessions,
        audit: ctx.audit,
        daemonId: ctx.daemonId,
      }
      if (ctx.generateConnSalt) fctx.generateConnSalt = ctx.generateConnSalt
      if (ctx.onSeal) fctx.onSeal = ctx.onSeal
      return createFrameBridge(fctx)
    })

  let generation = 0
  let reported: TunnelStatus = 'disabled'
  let revokedLatch = false
  let closing = false

  let socket: WebSocket | null = null
  let bridge: FrameBridge | null = null

  // Pairing-over-tunnel driver (plan steps 2+4). Built ONCE and lives across socket generations: its
  // active-pairing/boundJti state must survive a reconnect mid-pairing. `send` targets the CURRENT
  // socket (via the `socket` closure) — the relay fans daemon→ text frames to the phone's pair socket.
  // A tunnel built without a pairing engine has no driver; pairing text frames are then ignored.
  const createPairingTunnel = deps.createPairingTunnel ?? createRemotePairingTunnel
  const pairingDriver: RemotePairingTunnel | null = deps.pairing
    ? createPairingTunnel({
        pairing: deps.pairing,
        send: (frame) => {
          try {
            socket?.send(JSON.stringify(frame))
          } catch {
            // socket dying; the phone re-scans on failure (pairing is in-memory, no half-state to fix)
          }
        },
        postPairConfirm: deps.postPairConfirm ?? postPairConfirm,
        getGatewayUrl: deps.config.getGatewayUrl,
        getDaemonToken: deps.config.getDaemonToken,
      })
    : null

  let reconnectTimer: NodeJS.Timeout | null = null
  let hbIntervalTimer: NodeJS.Timeout | null = null
  let hbDeadlineTimer: NodeJS.Timeout | null = null

  const emit = (
    status: TunnelStatus,
    gen: number,
    extra: { reason?: string; nextRetryInMs?: number; gatewayUrl?: string } = {}
  ): void => {
    reported = status
    const event: TunnelStatusEvent = { status, generation: gen }
    if (extra.reason !== undefined) event.reason = extra.reason
    if (extra.nextRetryInMs !== undefined) event.nextRetryInMs = extra.nextRetryInMs
    if (extra.gatewayUrl !== undefined) event.gatewayUrl = extra.gatewayUrl
    deps.onStatus(event)
  }

  // Late handlers from a superseded socket must no-op. Each handler captures its generation; if a
  // newer (re)connect has bumped `generation`, the stale callback is dropped — this is what stops a
  // zombie socket's late message/close from writing onto a fresh socket.
  const guard = (gen: number, fn: () => void): void => {
    if (gen !== generation) return
    fn()
  }

  const clearReconnect = (): void => {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
    }
  }

  const stopHeartbeat = (): void => {
    if (hbIntervalTimer !== null) {
      clearTimer(hbIntervalTimer)
      hbIntervalTimer = null
    }
    if (hbDeadlineTimer !== null) {
      clearTimer(hbDeadlineTimer)
      hbDeadlineTimer = null
    }
  }

  const detachSocket = (): void => {
    if (socket) {
      // Drop our handlers so a teardown can't re-enter through a late event.
      socket.removeAllListeners()
      socket = null
    }
    bridge = null
  }

  const absorbIntentionalShutdownError = (s: WebSocket): void => {
    // `ws.close()`/`terminate()` aborts a CONNECTING handshake by emitting `error` asynchronously.
    // After intentional teardown we have removed the lifecycle handlers, so keep one local sink for
    // that expected shutdown event instead of letting Node treat it as unhandled.
    s.once('error', () => {})
  }

  const wantConnected = (): boolean =>
    deps.config.isEnabled() && deps.config.getDaemonToken() != null

  const armHeartbeat = (gen: number): void => {
    stopHeartbeat()
    hbIntervalTimer = setTimer(function tick() {
      guard(gen, () => {
        const s = socket
        if (!s) return
        try {
          s.send(HB_PING)
        } catch {
          // socket already dying; the close handler will drive recovery
          return
        }
        // Arm a deadline tracking the OLDEST unanswered ping. A pong (the DO's auto-response) clears
        // it; the next pong-cleared interval re-arms a fresh one. We do NOT reset the deadline on each
        // ping — otherwise an interval shorter than the deadline would mask a dead socket forever (a
        // new ping would keep pushing the deadline out even with zero pongs coming back).
        if (hbDeadlineTimer === null) {
          hbDeadlineTimer = setTimer(() => {
            hbDeadlineTimer = null
            guard(gen, () => onSocketDown(1006, 'heartbeat timeout'))
          }, hbDeadline)
        }
        // re-arm the next ping
        hbIntervalTimer = setTimer(tick, hbInterval)
      })
    }, hbInterval)
  }

  const onHeartbeatPong = (): void => {
    if (hbDeadlineTimer !== null) {
      clearTimer(hbDeadlineTimer)
      hbDeadlineTimer = null
    }
  }

  const onControl = (raw: string): void => {
    let c: GatewayControl
    try {
      c = JSON.parse(raw.slice(GW_CONTROL_PREFIX.length)) as GatewayControl
    } catch {
      return
    }
    switch (c.t) {
      case 'revoked':
        revokeAndStop(c.reason)
        break
      case 'peer-offline':
        // A pair peer-offline (the unpaired phone's /relay/pair socket closing — normal at the end of
        // every pairing, on replace, or when the phone navigates away) is a CONTROL-PLANE event and must
        // NOT touch the DATA tunnel — otherwise a pairing-socket churn would reset an already-paired
        // phone's in-flight streams (the relay-do invariant: ignore role:'pair' for stream-reset). Only a
        // device/daemon peer-offline resets streams: that DATA phone went away; reset the in-flight
        // streams but KEEP the live socket + outbound sink so it can re-establish on 'peer-online'
        // (nulling the sink would silently swallow every later response).
        if (c.role !== 'pair') bridge?.resetAllStreams('peer offline', { keepSink: true })
        break
      case 'peer-online':
        // A pair peer-online (an unpaired phone attached to relay /relay/pair for this daemon) carries
        // the pairing session's jti (D2). Hand it to the pairing driver as the active boundJti; a NEW
        // peer-online also resets the driver's active pairing (D1 replace race). daemon/device
        // peer-online stay informational (the data plane needs no presence action here).
        if (c.role === 'pair') pairingDriver?.onPeerOnline(c.jti)
        break
      case 'error':
        onSocketDown(c.code, c.message)
        break
    }
  }

  const onMessage = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
    if (!isBinary) {
      const s = data.toString()
      if (s === HB_PONG) {
        onHeartbeatPong()
        return
      }
      if (s.startsWith(GW_CONTROL_PREFIX)) {
        onControl(s)
        return
      }
      // Pairing TEXT frames (phone↔daemon over the relay, plan step 2). They are NOT the binary data
      // plane and NOT the gateway control band — the relay forwards them opaque from the pair socket.
      // Route to the pairing driver; a non-pairing / junk string is ignored there (and below).
      if (pairingDriver) {
        pairingDriver.onPairingFrame(s)
        return
      }
      // unknown string: ignore (the relay never sends non-sentinel strings)
      return
    }
    bridge?.onInbound(toArrayBuffer(data))
  }

  const onSocketDown = (code: number, reason: string): void => {
    stopHeartbeat()
    bridge?.resetAllStreams(reason)
    deps.audit.enqueue({ action: 'session_close', result: 'ok', rejectReason: reason })
    const s = socket
    detachSocket()
    if (s) {
      absorbIntentionalShutdownError(s)
      try {
        s.terminate()
      } catch {
        // already gone
      }
    }
    // Invalidate the generation so any further late event from this socket no-ops.
    generation += 1

    if (closing) return
    if (isAuthFatalCloseCode(code)) {
      revokedLatch = true
      emit('revoked', generation, { reason })
      return
    }
    if (!wantConnected()) {
      emit(deps.config.isEnabled() ? 'loggedOut' : 'disabled', generation, { reason })
      return
    }
    const delay = backoff.next()
    emit('reconnecting', generation, { reason, nextRetryInMs: delay })
    clearReconnect()
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      openSocket()
    }, delay)
  }

  const openSocket = (): void => {
    if (closing || revokedLatch) return
    const gen = ++generation

    if (!deps.config.isEnabled()) {
      emit('disabled', gen)
      return
    }
    const gatewayUrl = deps.config.getGatewayUrl()
    const token = deps.config.getDaemonToken()
    if (!gatewayUrl || !token) {
      emit('loggedOut', gen)
      return
    }

    let url: string
    try {
      url = relayDaemonUrl(gatewayUrl)
    } catch (err) {
      emit('reconnecting', gen, {
        reason: err instanceof Error ? err.message : 'bad gateway url',
      })
      return
    }

    emit('connecting', gen)
    let s: WebSocket
    try {
      s = new WebSocketImpl(url, [`bearer.${token}`])
    } catch {
      // Construction itself failed (e.g. malformed url) — treat as a transient drop.
      onSocketDown(1006, 'socket construction failed')
      return
    }
    socket = s
    s.binaryType = 'arraybuffer'

    s.on('open', () =>
      guard(gen, () => {
        // M6.1: the daemon id is bound into the per-connection HKDF info; it MUST match what the phone
        // stored at pairing. Source it from config (the same value written to StoredDeviceSession),
        // NOT from a non-existent deps.daemonId field. Guard null — the tunnel can't be online without
        // a daemon id, but if it ever were, the bridge has no valid id to bind and we must not connect.
        const daemonId = deps.config.getDaemonId()
        if (!daemonId) {
          onSocketDown(1006, 'missing daemon id')
          return
        }
        const ctx: BridgeContext = {
          loopbackPort: deps.loopbackPort,
          loopbackSecret: deps.loopbackSecret,
          deviceSessions: deps.deviceSessions,
          audit: deps.audit,
          daemonId,
        }
        bridge = createBridge(ctx)
        bridge.attachSocket((frame) => {
          try {
            s.send(frame)
          } catch {
            // socket dying; close handler recovers
          }
        })
        backoff.reset()
        armHeartbeat(gen)
        deps.audit.enqueue({ action: 'session_open', result: 'ok' })
        emit('online', gen, { gatewayUrl })
      })
    )
    s.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) =>
      guard(gen, () => onMessage(data, isBinary))
    )
    s.on('close', (code: number, reasonBuf: Buffer) =>
      guard(gen, () => onSocketDown(code, reasonBuf.toString() || 'closed'))
    )
    s.on('error', () => guard(gen, () => onSocketDown(1006, 'socket error')))
    // ws emits 'unexpected-response' for a non-101 upgrade (e.g. the gateway Worker's HTTP 401 when
    // the token isn't live yet). This is TRANSIENT — back off and retry. The AUTHORITATIVE credential
    // death is the post-handshake signal: a 4401/4410 close code or a `revoked` control frame. So a
    // handshake rejection must NOT latch revoked (that would strand the daemon on a token that's
    // merely mid-rotation); it falls through to onSocketDown's backoff path with 1006.
    s.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) =>
      guard(gen, () => onSocketDown(1006, `unexpected response ${res.statusCode ?? '?'}`))
    )
  }

  const teardownSocket = (code: number, reason: string): void => {
    stopHeartbeat()
    clearReconnect()
    bridge?.resetAllStreams(reason)
    const s = socket
    detachSocket()
    if (s) {
      absorbIntentionalShutdownError(s)
      try {
        s.close(code, reason)
      } catch {
        try {
          s.terminate()
        } catch {
          // gone
        }
      }
    }
  }

  function revokeAndStop(reason: string): void {
    if (revokedLatch && socket === null) {
      // already revoked
      revokedLatch = true
      return
    }
    revokedLatch = true
    teardownSocket(1000, reason)
    generation += 1
    deps.audit.enqueue({
      action: 'session_close',
      result: 'rejected',
      rejectReason: 'revoked',
    })
    emit('revoked', generation, { reason })
  }

  const refresh = (): void => {
    if (closing) return
    revokedLatch = false
    clearReconnect()

    if (!deps.config.isEnabled()) {
      if (socket) teardownSocket(1000, 'disabled')
      generation += 1
      emit('disabled', generation)
      return
    }
    if (deps.config.getDaemonToken() == null) {
      if (socket) teardownSocket(1000, 'logged out')
      generation += 1
      emit('loggedOut', generation)
      return
    }
    // Desired = connected. If we already have a live socket, leave it; otherwise (re)open.
    if (socket && (reported === 'online' || reported === 'connecting')) return
    openSocket()
  }

  const close = async (): Promise<void> => {
    closing = true
    clearReconnect()
    stopHeartbeat()
    const s = socket
    bridge?.resetAllStreams('shutdown')
    detachSocket()
    generation += 1
    if (!s) return
    absorbIntentionalShutdownError(s)
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const grace = setTimer(() => {
        try {
          s.terminate()
        } catch {
          // gone
        }
        done()
      }, CLOSE_GRACE_MS)
      s.once('close', () => {
        clearTimer(grace)
        done()
      })
      try {
        s.close(1000, 'shutdown')
      } catch {
        clearTimer(grace)
        try {
          s.terminate()
        } catch {
          // gone
        }
        done()
      }
    })
  }

  return {
    status: () => reported,
    refresh,
    revokeAndStop,
    closeDevice: (deviceId, reason) => bridge?.closeDevice(deviceId, reason),
    confirmPairing: async (pairingId, name) =>
      (await pairingDriver?.confirm(pairingId, name)) ?? null,
    close,
  }
}
