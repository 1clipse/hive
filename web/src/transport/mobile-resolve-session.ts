// The mobile bundle's `resolveSession` (boot-transport's injected crypto seam). Given a selected daemon
// and the persisted device-session record, it produces the TunnelSession the connect-flow swaps in.
//
// Two pieces of material are assembled:
//   - roots: the persisted directional ROOT keys (d2p/p2d), decoded from base64url. The mux derives a
//     fresh per-connection AEAD key from these every (re)connect — they are never AEAD keys directly.
//   - phoneSessionToken: the device-bound gateway JWT VALUE. The relay socket puts it in
//     Sec-WebSocket-Protocol: bearer.<token>. A browser WebSocket can't send Authorization and can't
//     read the HttpOnly hive_gw_session cookie, and /relay forbids cookie auth (HARDEN 6.1) — so the
//     gateway's POST /pair/relay-token endpoint is the only bridge: it re-reads the device session
//     cookie and echoes back its raw JWT value. Yes, this hands the device-bound token to JS, but it is
//     the same reach the device already has (the cookie rides the gateway origin anyway); the bundle is
//     SRI-pinned (TOFU). We do NOT mint a new session here — the value is the existing cookie's.

// Reaches the shared crypto (runs in node + browser); same relative depth as frame-mux/pairing-client.
import { fromBase64Url } from '../../../src/shared/remote-crypto.js'
import type { ResolveSession } from './boot-transport.js'
import type { TunnelSession } from './tunnel-transport.js'

export const mobileResolveSession: ResolveSession = async ({ stored }): Promise<TunnelSession> => {
  // connect-flow always re-reads + passes the persisted record once a daemon is selected/paired, so a
  // null here is a real bug, not a normal "not paired yet" path (that's handled before resolveSession).
  if (!stored) {
    throw new Error('mobileResolveSession: no persisted device session for the selected daemon')
  }

  // Pin BOTH the relay-token fetch and the relay socket to the TRUSTED origin the bundle was served
  // from (window.location.origin = the gateway). NEVER stored.gatewayUrl: that is an attacker-
  // influenceable QR-payload value (a spoofed QR could aim a credentialed POST at an arbitrary origin),
  // and in prod it is the daemon's remote_gateway_url which is HTTPS — `new WebSocket('https://…')`
  // would throw. The relay-token fetch needs the HTTPS origin; the relay socket needs the WSS origin.
  const httpOrigin = window.location.origin
  const wssOrigin = httpOrigin.replace(/^http/, 'ws') // https→wss, http→ws (loopback dev)

  const res = await fetch(`${httpOrigin}/pair/relay-token`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    // 403 = the device session was revoked. Attach a marker so the connect-flow can clear the
    // stored record and surface a distinct failure banner (rather than a generic select_failed).
    throw Object.assign(
      new Error(`mobileResolveSession: relay-token request failed (${res.status})`),
      {
        relayTokenStatus: res.status,
      }
    )
  }
  const { token } = (await res.json()) as { token: string }

  return {
    roots: {
      d2p: fromBase64Url(stored.rootKeys.d2p),
      p2d: fromBase64Url(stored.rootKeys.p2d),
    },
    deviceId: stored.deviceId,
    daemonId: stored.daemonId,
    gatewayUrl: wssOrigin,
    phoneSessionToken: token,
  }
}
