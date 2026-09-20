import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { bundleRoutes } from './bundles.js'
import { daemonRoutes } from './daemon.js'
import type { Env } from './env.js'
import { ghAuthorize, ghCallback } from './oauth-github.js'
import { googleAuthorize, googleCallback } from './oauth-google.js'
import { pageRoutes } from './pages.js'
import { pairRoutes } from './pair.js'
import { clientIpKey, makeRateLimiter, type RateLimitEndpoint, rateLimit } from './rate-limit.js'
import { relayConnect } from './relay-do.js'
import { sessionFromRequest } from './sessions.js'

// Gateway router entry. The gateway does exactly two things: IDENTITY (OAuth, sessions, daemon
// binding) and ROUTING (the opaque relay). It never decrypts terminal/API content. Rate-limit
// middleware is registered BEFORE the matching route so a 429 short-circuits ahead of any handler/DB
// work (security invariant #6).
const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

// --- IDENTITY: OAuth login (first login == signup; no passwords) ---
// Login is rate-limited per client IP (CF-Connecting-IP only — never a spoofable X-Forwarded-For).
app.use(
  '/auth/*',
  rateLimit('login', (c) => clientIpKey(c.env, c.req.raw))
)
app.get('/auth/github', ghAuthorize)
app.get('/auth/github/callback', ghCallback)
app.get('/auth/google', googleAuthorize)
app.get('/auth/google/callback', googleCallback)

// --- daemon binding (security invariant #6) ---
// /code (low-volume code issuance) gets the tight per-IP codeExchange budget. /token is POLLED every
// 2s for up to the 10-min code TTL while a human approves, so it gets its own generous per-IP tokenPoll
// budget — a codeExchange-sized cap would 429 the poll before approval and break every login (the code
// is a 256-bit unguessable token, so /token is not a real brute-force surface; see RATE_RULES).
// /approve is the trust-root: keyed on a VERIFIED session (HARDEN §8) so a forged cookie can't poison
// the bucket; unauthenticated attempts are bounded per-IP and short-circuited 401 before DB work.
app.use(
  '/daemon/code',
  rateLimit('codeExchange', (c) => clientIpKey(c.env, c.req.raw))
)
app.use(
  '/daemon/token',
  rateLimit('tokenPoll', (c) => clientIpKey(c.env, c.req.raw))
)
app.use('/daemon/approve', approveRateLimit)
app.route('/daemon', daemonRoutes)

// --- ROUTING: the opaque relay. The Worker verifies the credential (daemon token / session JWT),
// rejects cross-account routing, then upgrades into the per-account DO. Auth lives in relayConnect.
app.get('/relay', (c) => relayConnect(c, 'device')) // phone: ?daemonId + Sec-WebSocket-Protocol bearer
app.get('/relay/daemon', (c) => relayConnect(c, 'daemon')) // daemon: Sec-WebSocket-Protocol bearer
// M5a — pairing-relay channel for an UNPAIRED phone (deviceId=null session). Pairing handshake frames
// only; relayPair's deviceId===null gate is the inverse of /relay's device gate. The WS upgrade
// normally carries its token in Sec-WebSocket-Protocol. For first-pairing, the phone has only an
// HttpOnly browser-login cookie, so /relay/pair also accepts the same-origin cookie after the Origin
// gate; /relay data sockets and /relay/daemon stay bearer-only. Per-IP caps pairing-socket-open floods
// without coupling the limiter to the WS subprotocol or cookie surface.
app.use(
  '/relay/pair',
  rateLimit('codeExchange', (c) => clientIpKey(c.env, c.req.raw))
)
app.get('/relay/pair', (c) => relayConnect(c, 'pair')) // phone: ?daemonId + bearer OR same-origin cookie

// --- M5a pairing control-plane (JSON). /pair/confirm is daemon-token-authed (the only device-row
// creator); /pair/session + /pair/machines are session-authed. Rate-limited BEFORE the handler so a
// 429 short-circuits ahead of DB work (security invariant #6).
app.use(
  '/pair/confirm',
  rateLimit('codeExchange', (c) => clientIpKey(c.env, c.req.raw))
)
app.use(
  '/pair/revoke',
  rateLimit('codeExchange', (c) => clientIpKey(c.env, c.req.raw))
)
app.use('/pair/session', sessionRateLimit('codeExchange'))
// /pair/relay-token is session-authed (paired device). Same key-poisoning defense as /pair/session
// (verify session FIRST, key per-account), but on its OWN relayToken budget — the phone re-reads its
// token here on every (re)connect, so sharing /pair/session's tight bucket let a reconnect storm 429 a
// legitimate fresh pairing. Registered BEFORE the route so a 429 short-circuits ahead of handler work.
app.use('/pair/relay-token', sessionRateLimit('relayToken'))
app.route('/pair', pairRoutes)

// --- pages (login / machines / pair / privacy / terms) + versioned bundle distribution ---
app.route('/', pageRoutes)
app.route('/', bundleRoutes)

export default app

export { RateLimitDO } from './rate-limit.js'
export { RelayDO } from './relay-do.js'

// Approve limiter (HARDEN §8 — key-poisoning defense). The generic rateLimit() middleware keys
// synchronously, but the approve key MUST come from a verified session, which is async. So this is a
// bespoke middleware: verify the session FIRST, then key per-account (count both success and failure);
// if there's no valid session, key per-IP, count the attempt, and short-circuit 401 before any DB
// work in the handler. A rotating/forged cookie therefore can't mint a fresh per-account bucket — it
// stays anonymous and shares the per-IP bucket.
async function approveRateLimit(
  c: Context<{ Bindings: Env }>,
  next: () => Promise<void>
): Promise<Response | undefined> {
  // Only the POST is the trust-root mutation (binds a daemon, DB write) that needs the key-poisoning
  // limiter + the unauthenticated 401. The GET is just the confirm PAGE: like the other session-gated
  // pages (/machines, /pair) it has no limiter and redirects a logged-out viewer to login instead of
  // 401ing — so let it through to its handler. It does no DB work and mints a CSRF token only for an
  // already-authenticated session, so there's nothing here to flood.
  if (c.req.method !== 'POST') {
    await next()
    return
  }

  const limiter = makeRateLimiter(c.env.RATELIMIT)
  const now = Date.now()
  const session = await sessionFromRequest(c.env, c.req.raw)

  if (session === null) {
    // Unauthenticated: bound per-IP and refuse before touching the DB (self-approval defense). Counting
    // here means a flood of forged-cookie POSTs is capped by the per-IP codeExchange budget.
    const decision = await consumeFor(limiter, 'codeExchange', clientIpKey(c.env, c.req.raw), now)
    if (!decision.allowed) return rateLimited(c, decision.resetMs, now)
    return c.json({ error: 'login_required' }, 401)
  }

  // Authenticated: per-account approve budget; count this attempt regardless of its outcome.
  const decision = await consumeFor(limiter, 'approve', session.userId, now)
  if (!decision.allowed) return rateLimited(c, decision.resetMs, now)
  await next()
}

function consumeFor(
  limiter: ReturnType<typeof makeRateLimiter>,
  endpoint: RateLimitEndpoint,
  key: string,
  now: number
) {
  return limiter.check(endpoint, key, now)
}

// Session-keyed limiter for the M5a pairing endpoints (/relay/pair, /pair/session). Same key-poisoning
// defense as approveRateLimit: verify the session FIRST, then key per-account; an unauthenticated
// caller is bounded per-IP and short-circuited 401 before any handler/DB work, so a rotating/forged
// cookie can't mint a fresh per-account bucket. We do NOT count the per-account attempt here (the
// handler decides success/failure); the per-account bucket caps total pairing churn.
function sessionRateLimit(endpoint: RateLimitEndpoint): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limiter = makeRateLimiter(c.env.RATELIMIT)
    const now = Date.now()
    const session = await sessionFromRequest(c.env, c.req.raw)

    if (session === null) {
      const decision = await consumeFor(limiter, endpoint, clientIpKey(c.env, c.req.raw), now)
      if (!decision.allowed) return rateLimited(c, decision.resetMs, now)
      return c.json({ error: 'login_required' }, 401)
    }

    const decision = await consumeFor(limiter, endpoint, session.userId, now)
    if (!decision.allowed) return rateLimited(c, decision.resetMs, now)
    await next()
  }
}

function rateLimited(c: Context<{ Bindings: Env }>, resetMs: number, now: number): Response {
  const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000))
  return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) })
}
