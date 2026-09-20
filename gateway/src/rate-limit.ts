// Rate limiting — login / daemon-code-exchange / daemon-approve. A per-key sliding-window Durable
// Object (NOT the CF Rate Limit binding: that's fixed 10s/60s periods and can't be driven offline in
// workerd). One DO instance per bucket key gives single-threaded serialization of consume() for free,
// and an injected `now` makes the window deterministic to test (trip AND reset).
//
// HARDEN §7.1 — client-IP keying: production reads the client IP ONLY from CF-Connecting-IP, which
// the edge sets and a client can't spoof. We NEVER trust X-Forwarded-For (fully client-controlled). If
// CF-Connecting-IP is absent we FAIL CLOSED to one shared 'unknown' bucket rather than fall through to
// a spoofable header (which would let an attacker rotate a fake IP for unlimited attempts). A test-only
// IP-override header is honored ONLY as a fallback when CF-Connecting-IP is absent AND the override is
// named by env — so in prod (var unset, edge always sets CF-Connecting-IP) it can never bypass a bucket.
//
// HARDEN §8 — the approve limiter keys on a VERIFIED session userId, never a client-supplied cookie
// value. Unauthenticated attempts key per-IP and short-circuit before any DB work (see index.ts).

import { DurableObject } from 'cloudflare:workers'
import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from './env.js'

export interface RateLimitRule {
  limit: number
  windowMs: number
}

// Buckets. login + codeExchange are per-IP (anonymous surfaces); approve is per-account (keyed on a
// verified session userId). Windows are 60s sliding.
export const RATE_RULES = {
  login: { limit: 10, windowMs: 60_000 }, // /auth/* + callbacks, per IP
  approve: { limit: 20, windowMs: 60_000 }, // /daemon/approve, per account
  codeExchange: { limit: 5, windowMs: 60_000 }, // /daemon/code + /relay/pair + /pair/confirm, per IP (low-volume, brute-force/abuse surface)
  // /daemon/token — the daemon POLLS this every DAEMON_CODE_POLL_MS (2s) for up to the 10-min code
  // TTL while a human approves, so a tight bucket would 429 the poll long before approval and break
  // EVERY login. The code is a 256-bit unguessable token (`hc_<base64url>`), so /daemon/token is NOT
  // a real brute-force surface (guessing is 2^-256) and minting happens once — it just needs to
  // survive the natural poll rate. ~30 polls/min/login; allow ~3× for retries + a few daemons behind
  // one NAT, still bounded so a stuck client can't hammer forever.
  tokenPoll: { limit: 90, windowMs: 60_000 }, // /daemon/token, per IP — sized for the 2s poll cadence
  // /pair/relay-token — the phone re-reads its device JWT here on EVERY (re)connect / reload (a cheap,
  // idempotent cookie echo, not a trust-root mutation). Sharing /pair/session's tight 5/min bucket let a
  // reconnect storm 429 a legitimate fresh pairing for the same account, so it gets its own per-account
  // budget sized for connect/reconnect cadence.
  relayToken: { limit: 60, windowMs: 60_000 }, // /pair/relay-token, per account
} as const satisfies Record<string, RateLimitRule>

export type RateLimitEndpoint = keyof typeof RATE_RULES

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  resetMs: number // epoch ms when the oldest live hit ages out (Retry-After basis)
}

export interface RateLimiter {
  check(endpoint: RateLimitEndpoint, key: string, now: number): Promise<RateLimitDecision>
}

// One DO instance per (endpoint, key). The endpoint prefix keeps the same IP's login and codeExchange
// budgets independent (different DO ids), so flooding /daemon/token never burns the /auth/* budget.
export function bucketKey(endpoint: RateLimitEndpoint, key: string): string {
  return `${endpoint}:${key}`
}

// ---------------------------------------------------------------------------
// Sliding-window store. Keeps the timestamps of live hits in DO storage and decays them against the
// caller-provided `now`. Because each bucket is its own DO, consume() is serialized per key with no
// extra locking. `now` is injected (no hidden Date.now()) so the window is deterministic in tests.
// ---------------------------------------------------------------------------
export class RateLimitDO extends DurableObject<Env> {
  // Synchronous SQLite KV (RateLimitDO is a new_sqlite_classes DO): each get/put is immediately
  // durable + transactional, so a hit recorded in one request is visible to the next. The async
  // storage buffer would be consistent within a single activation but is not the right primitive for
  // a counter that must survive across separate RPC calls.
  async consume(rule: RateLimitRule, now: number): Promise<RateLimitDecision> {
    const stored = this.ctx.storage.kv.get('hits') as number[] | undefined
    // drop hits that have aged out of the window
    const live = (stored ?? []).filter((t) => t > now - rule.windowMs)

    if (live.length >= rule.limit) {
      // blocked — Retry-After is when the OLDEST live hit leaves the window. live[0] is number |
      // undefined under noUncheckedIndexedAccess; the ?? now keeps it well-defined.
      const oldest = live[0] ?? now
      // persist the pruned set so storage doesn't keep dead hits even while blocked
      this.ctx.storage.kv.put('hits', live)
      return { allowed: false, remaining: 0, resetMs: oldest + rule.windowMs }
    }

    live.push(now)
    this.ctx.storage.kv.put('hits', live)
    // Self-prune: wake once the window after the newest hit so an idle bucket doesn't retain storage.
    await this.ctx.storage.setAlarm(now + rule.windowMs)
    return { allowed: true, remaining: rule.limit - live.length, resetMs: now + rule.windowMs }
  }

  // When the window has fully passed with no new hits, clear the bucket so storage doesn't linger.
  override async alarm(): Promise<void> {
    this.ctx.storage.kv.delete('hits')
  }
}

// Routes a check to the per-key DO. The stub is typed to the class so consume()'s RPC is type-safe.
export function makeRateLimiter(ns: DurableObjectNamespace<RateLimitDO>): RateLimiter {
  return {
    async check(endpoint, key, now) {
      const stub = ns.get(ns.idFromName(bucketKey(endpoint, key)))
      return stub.consume(RATE_RULES[endpoint], now)
    },
  }
}

// HARDEN §7.1 — derive the client IP key. CF-Connecting-IP only (edge-set, unspoofable). If absent,
// fail closed to a single 'unknown' bucket; NEVER trust X-Forwarded-For. A test override header is a
// fallback ONLY when CF-Connecting-IP is missing AND env names it — so a prod request (edge always
// sets CF-Connecting-IP, RATELIMIT_TEST_IP_HEADER unset) can never use it to dodge a bucket.
export function clientIpKey(env: Env, req: Request): string {
  const edgeIp = req.headers.get('CF-Connecting-IP')
  if (edgeIp) return edgeIp

  const overrideHeader = (env as { RATELIMIT_TEST_IP_HEADER?: string }).RATELIMIT_TEST_IP_HEADER
  if (overrideHeader) {
    const v = req.headers.get(overrideHeader)
    if (v) return v
  }
  // Fail closed: do NOT fall through to client X-Forwarded-For.
  return 'unknown'
}

// Hono middleware that counts the attempt BEFORE the route handler runs (so an invalid /daemon/token
// or a failed approve still consumes budget) and short-circuits 429 + Retry-After when over the limit.
// `clientKey` derives the bucket key from the request (IP for login/codeExchange, verified userId for
// approve). The limiter is registered with app.use() ahead of the matching route in index.ts.
export function rateLimit(
  endpoint: RateLimitEndpoint,
  clientKey: (c: Context<{ Bindings: Env }>) => string
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limiter = makeRateLimiter(c.env.RATELIMIT)
    const decision = await limiter.check(endpoint, clientKey(c), Date.now())
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil((decision.resetMs - Date.now()) / 1000))
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) })
    }
    await next()
  }
}
