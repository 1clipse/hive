// M5a STAGE 6 — boot wiring. The single seam that decides which transport the bundle rides when it
// boots, and (for the mobile bundle) the connect-time swap that installs the TunnelTransport.
//
// Two paths, strictly additive:
//
//   DESKTOP (local runtime, loopback origin, no gateway build flag):
//     bootTransport() returns { mode: 'direct' } and does NOTHING. DirectTransport is already the
//     default activeTransport in api.ts, so the desktop never imports/constructs tunnel code and
//     main.tsx mounts React with zero extra wiring. This is invariant 5: the desktop path is
//     byte-for-behavior identical to today.
//
//   MOBILE (gateway-served bundle):
//     bootTransport() returns { mode: 'tunnel', connectTransport }. It does NOT swap the transport at
//     boot — there is no device session until the user selects (and maybe pairs) a daemon. The mobile
//     entry (M5b) feeds `connectTransport` into createConnectFlow; the flow calls it once a daemon is
//     selected/paired, at which point a real TunnelTransport is built from the resolved device session,
//     waits for the E2E channel handshake, and only then swaps into api.ts via setApiTransport. From
//     then on every apiFetch / openWebSocket rides the E2E tunnel through the gateway relay — never the
//     gateway origin.
//
// This module holds NO crypto. Resolving the per-daemon device session (deriving d2p/p2d from the
// stored device keypair + daemon pubkey + a fresh salt — the genuinely-deferred silent-rebuild path,
// see device-session-store §4.1 and the spec §9) is an injected `resolveSession` dependency, kept out
// here exactly like connect-flow keeps `connectTransport` out of its own layer. The boot seam only
// wires resolveSession -> createTunnelTransport -> setApiTransport.

import { setApiTransport } from '../api.js'
import type { ConnectResult } from '../connect/connect-flow.js'
import type { ConnectionStatus } from './api-transport.js'
import type { StoredDeviceSession } from './device-session-store.js'
import { isGatewayServedBundle } from './select-transport.js'
import { createTunnelTransport, type TunnelSession } from './tunnel-transport.js'

/** Resolve the device session for a selected daemon. The crypto seam (§9): for a freshly-paired daemon
 *  the caller already holds the derived keys; for a silent rebuild it re-derives from `stored` + a
 *  fresh salt. Rejects when no key material is available (then no transport is installed). */
export type ResolveSession = (input: {
  daemonId: string
  deviceId: string
  stored: StoredDeviceSession | null
}) => Promise<TunnelSession>

export interface MakeTunnelConnectTransportDeps {
  resolveSession: ResolveSession
  /** Surfaced to the mobile shell's connection banner (M5b). Defaults to a no-op. */
  onStatus?: (status: ConnectionStatus) => void
  /** Injected for tests; defaults to the platform WebSocket. */
  WebSocketImpl?: typeof WebSocket
  /** Test seam for the first channel-ready wait. Production default is 10s. */
  readyTimeoutMs?: number
}

/** The connectTransport a ConnectFlow injects. Builds + installs a TunnelTransport for the selected
 *  daemon, or returns select_failed (and leaves the active transport untouched) if the session can't
 *  be resolved / made channel-ready — a failed resolution must NEVER swap in a half-open tunnel. */
export type ConnectTransport = (input: {
  daemonId: string
  deviceId: string
  stored: StoredDeviceSession | null
}) => Promise<ConnectResult>

export const makeTunnelConnectTransport = (
  deps: MakeTunnelConnectTransportDeps
): ConnectTransport => {
  const onStatus = deps.onStatus ?? (() => {})
  return async ({ daemonId, deviceId, stored }) => {
    let session: TunnelSession
    try {
      session = await deps.resolveSession({ daemonId, deviceId, stored })
    } catch (err) {
      // 403 from the relay-token endpoint = the device session was revoked on the daemon side.
      // Surface a distinct code so the connect-flow can clear the stored record + show better copy.
      const status = (err as Record<string, unknown>).relayTokenStatus
      if (status === 403) {
        return {
          ok: false,
          failure: {
            code: 'relay_revoked' as const,
            message: `device session revoked for ${daemonId}`,
          },
        }
      }
      // No key material (e.g. the deferred silent-rebuild can't derive without the pairing secret).
      // Surface a select failure; do NOT install a broken transport.
      return {
        ok: false,
        failure: {
          code: 'select_failed',
          message: `could not establish a session for ${daemonId}: ${(err as Error).message}`,
        },
      }
    }
    const transport = createTunnelTransport({
      session,
      onStatus,
      ...(deps.WebSocketImpl ? { WebSocketImpl: deps.WebSocketImpl } : {}),
    })
    try {
      await transport.ready({ timeoutMs: deps.readyTimeoutMs ?? 10_000 })
    } catch (err) {
      transport.dispose()
      return {
        ok: false,
        failure: {
          code: 'select_failed',
          message: `could not open a ready tunnel for ${daemonId}: ${(err as Error).message}`,
        },
      }
    }
    setApiTransport(transport)
    return { ok: true }
  }
}

export interface BootTransportDeps {
  /** Override the build-flag / host detection. Defaults to isGatewayServedBundle (the real seam). */
  isGateway?: () => boolean
  /** Required only on the mobile path; the crypto seam that produces a TunnelSession per daemon. */
  resolveSession?: ResolveSession
  onStatus?: (status: ConnectionStatus) => void
  WebSocketImpl?: typeof WebSocket
  readyTimeoutMs?: number
}

export type BootResult = { mode: 'direct' } | { mode: 'tunnel'; connectTransport: ConnectTransport }

/** Decide the boot transport. Desktop -> direct (no-op, DirectTransport stays default). Gateway bundle
 *  -> tunnel, surfacing the connectTransport the ConnectFlow installs once a daemon is selected. */
export const bootTransport = (deps: BootTransportDeps = {}): BootResult => {
  const isGateway = deps.isGateway ?? isGatewayServedBundle
  if (!isGateway()) {
    // Desktop: DirectTransport is already the default activeTransport. Touch nothing.
    return { mode: 'direct' }
  }
  if (!deps.resolveSession) {
    throw new Error('bootTransport: a gateway bundle requires resolveSession to build the tunnel')
  }
  const connectTransport = makeTunnelConnectTransport({
    resolveSession: deps.resolveSession,
    ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
    ...(deps.WebSocketImpl ? { WebSocketImpl: deps.WebSocketImpl } : {}),
    ...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
  })
  return { mode: 'tunnel', connectTransport }
}
