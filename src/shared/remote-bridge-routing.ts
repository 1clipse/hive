// The loopback bridge whitelist — the "not a general localhost proxy" gate.
//
// Runs in BOTH node and browser (pure, no I/O): the daemon runs it on the
// OPENED Open-frame StreamMeta, AFTER the frame authenticates (M1 openNext) and
// BEFORE any loopback socket exists. A { ok: false } decision => the tunnel
// sends Reset(StreamRefused) + emits a `reject` audit row, and NEVER makes a
// loopback request. Removing or weakening any check here turns the tunnel into
// an arbitrary localhost proxy — that is exactly what these checks forbid.
//
// Invariant 1 (binding): the bridge forwards ONLY /api/* and /ws/* (terminal +
// tasks). Everything else — traversal, encoded tricks, absolute URLs, the UI
// session cookie route — is refused here.

import { type StreamMeta, StreamTransport } from './remote-protocol.js'

export const ALLOWED_HTTP_PREFIX = '/api/' as const

// Exact terminal io/control + tasks ws paths — mirrors terminal-ws-server's
// matchTerminalPath regex and the /ws/tasks/<id> match in that file. Path-only:
// the WS query (clientId/cols/rows) rides separate StreamMeta fields, never the
// path, so we gate the bare path and reject any query smuggled into it.
const WS_TERMINAL_RE = /^\/ws\/terminal\/[^/]+\/(?:io|control)$/
const WS_TASKS_RE = /^\/ws\/tasks\/[^/]+$/

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

// HARDEN: /api/ui/session is UNAUTHENTICATED and unconditionally responds with
// Set-Cookie: hive_ui_token=<the master UI token>. The tunnel is authorized by
// the per-boot secret, so the phone has zero need for the UI cookie. Forwarding
// it would let a paired phone harvest the single credential that authenticates
// every /api/* route + WS upgrade. Hard-deny by exact pathname (case-folded),
// before prefix matching can let it through. This is layer (1) of the fix; the
// bridge's response-header sanitizer (remote-loopback-auth) is layer (2), and
// routes-ui refusing tunnel-tagged requests is layer (3).
const DENIED_HTTP_PATHS = new Set(['/api/ui/session'])

// HARDEN (trust-root defense-in-depth): the device-pairing TRUST-ROOT actions — begin a pairing,
// list pending approvals, confirm/approve a device, reject a pending one — are desktop-only at the route layer
// (routes-remote.gateLocalDesktopOnly). The Authority Model says a phone can NEVER self-approve a
// new device, so we mirror /api/ui/session's layered defense: layer 1 hard-denies these here on the
// bridge (a forwarded frame is Reset(StreamRefused) + audited path_denied), layer 3 is the route gate.
// `/api/remote/pairings` (begin, POST) collides with the collection path, and confirm/reject carry a
// :pairingId segment, so we deny by matcher rather than an exact-set entry. A phone still uses the
// EQUAL-AUTHORITY remote routes (list devices, revoke, status, audit) — only the trust root is denied.
const isDeniedPairingPath = (pathname: string): boolean => {
  if (pathname === '/api/remote/pairings') return true // begin a pairing (POST)
  if (pathname === '/api/remote/pairings/pending') return true // read pending SAS approvals (GET)
  // confirm/reject under /api/remote/pairings/:id — match the action suffix on a pairings path.
  return (
    pathname.startsWith('/api/remote/pairings/') &&
    (pathname.endsWith('/confirm') || pathname.endsWith('/reject'))
  )
}

export type BridgeRejectReason =
  | 'path_not_whitelisted'
  | 'path_not_canonical'
  | 'path_denied'
  | 'bad_method'
  | 'malformed_meta'

export type RouteDecision =
  | { ok: true; transport: 'http'; method: string; path: string }
  | { ok: true; transport: 'ws'; path: string; query?: [string, string][] }
  | { ok: false; reason: BridgeRejectReason }

// Canonicalization gate for the path SHAPE (no query handling — that is the
// caller's policy). Reject anything non-canonical so an encoded or traversal
// path can never reach a route that later decodes it.
//
// A query string is allowed structurally (it is not traversal); whether a query
// is *permitted* on a given transport is decided in classifyOpen.
export function isCanonicalPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path[0] !== '/') return false // no absolute URLs, no authority-relative
  if (path.includes('\0') || path.includes('\\')) return false
  if (/%2e|%2f/i.test(path)) return false // encoded . or / — refuse outright
  if (path.includes('..')) return false // any traversal segment
  if (path.startsWith('//')) return false // protocol-relative / authority
  // URL parse must round-trip the pathname (ignoring any query) unchanged and
  // not surface an injected host.
  let u: URL
  try {
    u = new URL(path, 'http://x')
  } catch {
    return false
  }
  if (u.host !== 'x') return false
  // pathname + search must reconstruct the input byte-for-byte: this rejects a
  // space or any char the URL parser would normalize/strip, while still
  // permitting a legitimate ?query.
  return u.pathname + u.search === path
}

// True if s contains any C0 control char (charCode 0..31). Used to keep a WS query pair from
// smuggling a NUL/CR/LF past the loopback-URL reattach.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x1f) return true
  }
  return false
}

export function classifyOpen(meta: StreamMeta): RouteDecision {
  if (meta.transport === StreamTransport.Http) {
    const m = meta.http
    if (!m) return { ok: false, reason: 'malformed_meta' }
    if (!isCanonicalPath(m.path)) return { ok: false, reason: 'path_not_canonical' }
    // Split off the query: the prefix/deny checks run on the pathname only, so a
    // query string can neither bypass the deny set nor break a legit /api route.
    const queryStart = m.path.indexOf('?')
    const pathname = queryStart === -1 ? m.path : m.path.slice(0, queryStart)
    const lowered = pathname.toLowerCase()
    if (DENIED_HTTP_PATHS.has(lowered) || isDeniedPairingPath(lowered)) {
      return { ok: false, reason: 'path_denied' }
    }
    if (!pathname.startsWith(ALLOWED_HTTP_PREFIX)) {
      return { ok: false, reason: 'path_not_whitelisted' }
    }
    if (!ALLOWED_METHODS.has(m.method)) return { ok: false, reason: 'bad_method' }
    return { ok: true, transport: 'http', method: m.method, path: m.path }
  }

  if (meta.transport === StreamTransport.Ws) {
    const w = meta.ws
    if (!w) return { ok: false, reason: 'malformed_meta' }
    if (!isCanonicalPath(w.path)) return { ok: false, reason: 'path_not_canonical' }
    // WS path is path-only — a query here is non-canonical (it must ride the
    // separate `query` meta field, reattached on the loopback URL).
    if (w.path.includes('?')) return { ok: false, reason: 'path_not_canonical' }
    if (!WS_TERMINAL_RE.test(w.path) && !WS_TASKS_RE.test(w.path)) {
      return { ok: false, reason: 'path_not_whitelisted' }
    }
    // The WS query rides separate [name,value] pairs. Reject any pair whose key/value carries a
    // control char that could break out of the query when we URL-encode it back (defense in depth —
    // even though we encodeURIComponent on reattach, a NUL/control char has no business in
    // clientId/cols/rows). An empty key is also nonsense.
    if (w.query !== undefined) {
      for (const [k, v] of w.query) {
        if (k.length === 0 || hasControlChar(k) || hasControlChar(v)) {
          return { ok: false, reason: 'malformed_meta' }
        }
      }
    }
    return w.query !== undefined
      ? { ok: true, transport: 'ws', path: w.path, query: w.query }
      : { ok: true, transport: 'ws', path: w.path }
  }

  return { ok: false, reason: 'malformed_meta' }
}
