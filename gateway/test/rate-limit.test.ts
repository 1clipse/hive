import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { upsertUser } from '../src/db.js'
import { bucketKey, clientIpKey, makeRateLimiter, RATE_RULES } from '../src/rate-limit.js'
import { BROWSER_SESSION_TTL_MS, mintSession, SESSION_COOKIE_NAME } from '../src/sessions.js'

// The rate limiter is a per-key sliding-window Durable Object. These tests are the point of the
// hardening: each one must fail if the limiter is off, off-by-one, keyed wrong, counts only
// successes, never decays, or can be bypassed by a spoofed client IP. We drive it three ways:
//   - the public routes (login / code-exchange / approve) end-to-end via SELF.fetch
//   - the DO consume() directly (runInDurableObject) with an INJECTED clock for the window-reset test
//   - the clientIpKey() helper directly for the spoof-resistance HARDEN §7.1 fix

const ORIGIN = 'https://app.hivehq.dev'

// Fresh bucket id per assertion: each consume() DO instance is keyed by idFromName(bucketKey), so a
// random key gives a clean window without touching storage isolation (which is off globally).
function freshKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

async function makeUser(sub: string): Promise<string> {
  const row = await upsertUser(env.DB, {
    provider: 'github',
    providerSub: sub,
    email: null,
    now: Date.now(),
    newId: crypto.randomUUID(),
  })
  return row.id
}

async function browserCookie(userId: string): Promise<string> {
  const { token } = await mintSession(env, {
    userId,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

afterEach(async () => {
  await env.DB.exec('DELETE FROM revocations')
})

// ---------------------------------------------------------------------------
// Sliding-window core (DO consume) — exercised with an injected clock so we can prove the window
// both TRIPS at the exact threshold and RESETS once `now` advances past windowMs.
// ---------------------------------------------------------------------------
describe('RateLimitDO.consume — sliding window with injected clock', () => {
  const rule = { limit: 3, windowMs: 1000 }

  test('allows up to `limit` in a window, then blocks (exact threshold, off-by-one)', async () => {
    const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName(freshKey('consume-trip')))
    const t0 = 1_000_000

    const decisions = await runInDurableObject(stub, async (inst) => {
      const out = []
      for (let i = 0; i < 4; i++) out.push(await inst.consume(rule, t0))
      return out
    })

    expect(decisions[0]?.allowed).toBe(true)
    expect(decisions[1]?.allowed).toBe(true)
    expect(decisions[2]?.allowed).toBe(true)
    // the 4th attempt inside the same window is over the limit of 3
    expect(decisions[3]?.allowed).toBe(false)
    expect(decisions[3]?.remaining).toBe(0)
  })

  test('remaining counts down as the window fills', async () => {
    const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName(freshKey('consume-remaining')))
    const t0 = 2_000_000
    const r = await runInDurableObject(stub, async (inst) => [
      await inst.consume(rule, t0),
      await inst.consume(rule, t0),
    ])
    expect(r[0]?.remaining).toBe(2)
    expect(r[1]?.remaining).toBe(1)
  })

  test('window RESETS once now advances past windowMs (no permanent lockout / non-decaying counter)', async () => {
    const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName(freshKey('consume-reset')))
    const t0 = 3_000_000

    const blocked = await runInDurableObject(stub, async (inst) => {
      await inst.consume(rule, t0)
      await inst.consume(rule, t0)
      await inst.consume(rule, t0)
      return inst.consume(rule, t0) // 4th in-window → blocked
    })
    expect(blocked.allowed).toBe(false)

    // advance the clock fully past the window — the old hits decay, so a fresh attempt is allowed
    const afterReset = await runInDurableObject(stub, async (inst) =>
      inst.consume(rule, t0 + rule.windowMs + 1)
    )
    expect(afterReset.allowed).toBe(true)
  })

  test('a partially-aged window keeps only the live hits (sliding, not fixed bucket)', async () => {
    const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName(freshKey('consume-slide')))
    const t0 = 4_000_000

    const out = await runInDurableObject(stub, async (inst) => {
      await inst.consume(rule, t0) // hit @ t0
      await inst.consume(rule, t0 + 500) // hit @ t0+500
      await inst.consume(rule, t0 + 600) // hit @ t0+600 → window full (3)
      // at t0+1100 the first hit (t0) has aged out, so exactly one slot frees up
      return inst.consume(rule, t0 + 1100)
    })
    expect(out.allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Keyed isolation: each (endpoint, key) is its OWN DO, so one key's exhausted window can't block a
// different key. We exhaust one bucket inside a single activation, then verify a fresh bucket is
// untouched. (Cross-request storage for a single bucket is proven on the real route path below — the
// raw-stub path in the test pool doesn't share storage with the runtime, so we don't drive multi-call
// counters through stub RPC here.)
// ---------------------------------------------------------------------------
describe('keyed isolation — distinct DO per bucket', () => {
  const rule = { limit: 3, windowMs: 1000 }

  test('an exhausted bucket does not block a different key (not a single global bucket)', async () => {
    const now = 5_000_000
    const stubA = env.RATELIMIT.get(env.RATELIMIT.idFromName(bucketKey('login', freshKey('iso-a'))))
    const stubB = env.RATELIMIT.get(env.RATELIMIT.idFromName(bucketKey('login', freshKey('iso-b'))))

    const aBlocked = await runInDurableObject(stubA, async (inst) => {
      for (let i = 0; i < rule.limit; i++) await inst.consume(rule, now)
      return inst.consume(rule, now) // over limit
    })
    expect(aBlocked.allowed).toBe(false)

    // a different bucket id is a different DO entirely — its first hit must be allowed
    const bOk = await runInDurableObject(stubB, async (inst) => inst.consume(rule, now))
    expect(bOk.allowed).toBe(true)
  })

  test('bucketKey namespaces by endpoint so the same IP has separate login / codeExchange budgets', () => {
    expect(bucketKey('login', '1.2.3.4')).not.toBe(bucketKey('codeExchange', '1.2.3.4'))
    expect(bucketKey('login', '1.2.3.4')).toBe('login:1.2.3.4')
  })

  test('makeRateLimiter routes a check without throwing (smoke — the real budgets ride the routes)', async () => {
    const limiter = makeRateLimiter(env.RATELIMIT)
    const d = await limiter.check('login', freshKey('smoke'), Date.now())
    expect(d.allowed).toBe(true)
    expect(d.remaining).toBe(RATE_RULES.login.limit - 1)
  })
})

// ---------------------------------------------------------------------------
// clientIpKey — HARDEN §7.1: prod reads ONLY CF-Connecting-IP (edge-set, unspoofable). A client
// X-Forwarded-For is NEVER trusted; a test override header is ignored when CF-Connecting-IP present.
// ---------------------------------------------------------------------------
describe('clientIpKey — spoof resistance (HARDEN §7.1)', () => {
  test('reads CF-Connecting-IP and ignores client X-Forwarded-For', () => {
    const req = new Request('https://x/', {
      headers: { 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '1.1.1.1' },
    })
    expect(clientIpKey(env, req)).toBe('9.9.9.9')
  })

  test('rotating X-Forwarded-For cannot escape the bucket — all collapse to the same key', () => {
    // No CF-Connecting-IP (edge would always set it; this is the fail-closed path). A spoofed,
    // ROTATING XFF must NOT produce a fresh key each request or the limiter is bypassable.
    const k1 = clientIpKey(
      env,
      new Request('https://x/', { headers: { 'X-Forwarded-For': '1.1.1.1' } })
    )
    const k2 = clientIpKey(
      env,
      new Request('https://x/', { headers: { 'X-Forwarded-For': '2.2.2.2' } })
    )
    expect(k1).toBe(k2) // both fail closed to the same bucket, not two attacker-chosen ones
  })

  test('the test IP-override header is IGNORED when CF-Connecting-IP is present (no prod bypass)', () => {
    // The override exists only for tests and only as a fallback. It must NEVER win over the edge IP,
    // or a request could set it per-request to dodge the bucket in a prod-like binding.
    const req = new Request('https://x/', {
      headers: { 'CF-Connecting-IP': '9.9.9.9', 'X-Hive-Test-Ip': 'attacker-rotates-this' },
    })
    expect(clientIpKey(env, req)).toBe('9.9.9.9')
  })
})

// ---------------------------------------------------------------------------
// End-to-end on the real routes: login, code-exchange, approve. Each uses a UNIQUE source IP per
// test (via CF-Connecting-IP) so the buckets don't bleed across tests under singleWorker.
// ---------------------------------------------------------------------------
describe('login limiter on /auth/* (per IP)', () => {
  test('the (limit+1)th login attempt from one IP → 429 (off / wrong-key catch)', async () => {
    const ip = freshKey('login-ip')
    const { limit } = RATE_RULES.login
    let last: Response | null = null
    for (let i = 0; i < limit; i++) {
      last = await SELF.fetch(`${ORIGIN}/auth/github`, {
        redirect: 'manual',
        headers: { 'CF-Connecting-IP': ip },
      })
      expect(last.status).not.toBe(429)
    }
    const blocked = await SELF.fetch(`${ORIGIN}/auth/github`, {
      redirect: 'manual',
      headers: { 'CF-Connecting-IP': ip },
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
  })

  test('a different IP is unaffected by another IP being blocked (keyed not global)', async () => {
    const ipA = freshKey('login-A')
    const ipB = freshKey('login-B')
    const { limit } = RATE_RULES.login
    for (let i = 0; i <= limit; i++) {
      await SELF.fetch(`${ORIGIN}/auth/github`, {
        redirect: 'manual',
        headers: { 'CF-Connecting-IP': ipA },
      })
    }
    // ipA is now blocked; ipB's first request must still go through
    const fresh = await SELF.fetch(`${ORIGIN}/auth/github`, {
      redirect: 'manual',
      headers: { 'CF-Connecting-IP': ipB },
    })
    expect(fresh.status).not.toBe(429)
  })
})

describe('tokenPoll limiter on /daemon/token (per IP, sized for the 2s poll cadence)', () => {
  test('polling /daemon/token past the codeExchange limit does NOT 429 (the poll-vs-limit bug)', async () => {
    // REGRESSION: /daemon/token used to share the tight codeExchange bucket (limit 5), but the daemon
    // polls it every 2s for up to the 10-min code TTL — so the 6th poll 429'd and login could NEVER
    // finish. It now rides its own generous tokenPoll budget. Poll well past codeExchange.limit and
    // assert NONE are throttled (each is an invalid code → 401, not 429). If /daemon/token regresses
    // onto codeExchange, the (codeExchange.limit+1)th call here flips to 429 and this fails.
    const ip = freshKey('token-poll-ip')
    const polls = RATE_RULES.codeExchange.limit + 25 // 30 — comfortably past 5, still under tokenPoll's 90
    for (let i = 0; i < polls; i++) {
      const r = await SELF.fetch(`${ORIGIN}/daemon/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ code: `bad-${i}` }),
      })
      expect(r.status).not.toBe(429)
      expect(r.status).toBe(401) // unapproved/invalid code — the poll is allowed through, just rejected
    }
  })

  test('/daemon/token still enforces a bound: consume(tokenPoll) blocks at exactly the limit', async () => {
    // It is generous, not unbounded — a stuck client can't hammer forever. Drive the DO directly with
    // the SAME rule the route uses (RATE_RULES.tokenPoll), so the limit can't silently become Infinity.
    const stub = env.RATELIMIT.get(env.RATELIMIT.idFromName(freshKey('token-poll-bound')))
    const rule = RATE_RULES.tokenPoll
    const now = 7_000_000
    const { lastAllowed, overLimit } = await runInDurableObject(stub, async (inst) => {
      let last: boolean | undefined
      for (let i = 0; i < rule.limit; i++) last = (await inst.consume(rule, now)).allowed
      return { lastAllowed: last, overLimit: (await inst.consume(rule, now)).allowed }
    })
    expect(lastAllowed).toBe(true) // the limit-th poll is still allowed
    expect(overLimit).toBe(false) // the (limit+1)th is blocked
  })
})

describe('codeExchange limiter on /daemon/code (per IP — code issuance stays tight)', () => {
  test('the (codeExchange.limit+1)th /daemon/code from one IP → 429', async () => {
    // Code issuance is low-volume (the CLI requests one per login) and creates a DB row, so it keeps
    // the tight bucket even though /daemon/token was loosened. Mutation: drop /daemon/code's limiter
    // and the (limit+1)th stops 429ing.
    const ip = freshKey('code-issue-ip')
    const { limit } = RATE_RULES.codeExchange
    for (let i = 0; i < limit; i++) {
      const r = await SELF.fetch(`${ORIGIN}/daemon/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({}),
      })
      expect(r.status).not.toBe(429) // 200 — a fresh code
    }
    const blocked = await SELF.fetch(`${ORIGIN}/daemon/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({}),
    })
    expect(blocked.status).toBe(429)
  })

  test('bucketKey isolates tokenPoll from codeExchange so /token polling never burns /code budget', () => {
    expect(bucketKey('tokenPoll', '1.2.3.4')).not.toBe(bucketKey('codeExchange', '1.2.3.4'))
  })
})

describe('approve limiter on /daemon/approve (per ACCOUNT, HARDEN §8 key-poisoning)', () => {
  test('the (limit+1)th approve from one session → 429', async () => {
    const userId = await makeUser('approve-limit')
    const cookie = await browserCookie(userId)
    const { limit } = RATE_RULES.approve

    let last: Response | null = null
    for (let i = 0; i <= limit; i++) {
      last = await SELF.fetch(`${ORIGIN}/daemon/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ code: `nope-${i}` }),
      })
    }
    expect(last?.status).toBe(429)
  })

  test('a forged userId in an UNVERIFIED cookie cannot escape the bucket (key poisoning)', async () => {
    // HARDEN §8: the approve key must come from a VERIFIED session, never a client-supplied userId.
    // An attacker who can only present a garbage cookie is unauthenticated → keyed per-IP and
    // short-circuited; rotating the bogus cookie value must NOT mint a fresh per-account bucket.
    const ip = freshKey('approve-forge-ip')
    const { limit } = RATE_RULES.approve
    let blocked = false
    for (let i = 0; i < limit + 5; i++) {
      const r = await SELF.fetch(`${ORIGIN}/daemon/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // a different forged "userId"-looking cookie each time — must not dodge the IP bucket
          Cookie: `${SESSION_COOKIE_NAME}=forged.${i}.${crypto.randomUUID()}`,
          'CF-Connecting-IP': ip,
        },
        body: JSON.stringify({ code: 'x' }),
      })
      if (r.status === 429) {
        blocked = true
        break
      }
      // unauthenticated attempts are 401 (no/invalid session), not 200
      expect(r.status).toBe(401)
    }
    expect(blocked).toBe(true)
  })
})

// keep the analyzer honest that beforeEach is intentionally unused here (per-test fresh keys instead)
beforeEach(() => {})
