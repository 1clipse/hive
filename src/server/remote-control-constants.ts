// Daemon-side re-declaration of the gateway's control-band wire contract.
//
// The gateway lives in gateway/src/relay-do.ts — a separate Cloudflare-Workers package that is NOT
// import-reachable from src/ (importing it would drag in cloudflare:workers). So the daemon mirrors
// the few values it has to agree on, and tests/unit/remote-control-constants.test.ts pins each one
// to the literal gateway value so the wire format can never silently drift between the two sides.

// Control-frame sentinel. The gateway prefixes every control message (peer presence, revocation)
// with this so it can never be confused with an opaque binary E2E frame. relay-do.ts:29.
export const GW_CONTROL_PREFIX = '\x00gw:'

// WebSocket close codes (4xxx app range). relay-do.ts:32-41.
export const RelayCloseCode = {
  Normal: 1000,
  ProtocolError: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  DaemonOffline: 4404,
  Replaced: 4409,
  Revoked: 4410,
  InternalError: 4500,
} as const
export type RelayCloseCode = (typeof RelayCloseCode)[keyof typeof RelayCloseCode]

// Gateway-originated control frames (JSON after the sentinel). These are NOT E2E payload — the
// daemon interprets them directly. relay-do.ts:46-58.
//
// 'pair' is the M5a pairing-relay role (an UNPAIRED phone relaying the pairing handshake). Its
// peer-online ADDITIONALLY carries the pairing session's `jti` (D2): the phone can't read its own jti
// (HttpOnly cookie), so the daemon captures it here and uses it as boundJti for /pair/confirm. Only
// the pair role carries jti; daemon/device peer-online are unchanged.
export type GatewayControl =
  | { t: 'peer-online'; role: 'daemon' | 'device' | 'pair'; jti?: string }
  | { t: 'peer-offline'; role: 'daemon' | 'device' | 'pair' }
  | { t: 'revoked'; reason: string }
  | { t: 'error'; code: number; message: string }

// Idle keepalive: the daemon SENDS this app-level string and the DO auto-replies HB_PONG WITHOUT
// waking (setWebSocketAutoResponse, relay-do.ts:144). A protocol-level ws.ping() would wake the DO
// and burn duration — the heartbeat MUST be this string, never ws.ping().
export const HB_PING = 'hb:ping'
export const HB_PONG = 'hb:pong'

// Only these two close codes are authoritative credential death: the daemon must LATCH (stop
// retrying until refresh() re-reads config). Every other close — including 4404 DaemonOffline,
// 4409 Replaced, and the transport 1006 — is transient and backs off + retries.
export const isAuthFatalCloseCode = (code: number): boolean =>
  code === RelayCloseCode.Unauthorized || code === RelayCloseCode.Revoked
