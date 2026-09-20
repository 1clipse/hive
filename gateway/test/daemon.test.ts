import { env, SELF } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { upsertUser } from '../src/db.js'
import { BROWSER_SESSION_TTL_MS, mintSession, SESSION_COOKIE_NAME } from '../src/sessions.js'

const ORIGIN = 'https://app.hivehq.dev'

// Fresh edge IP per request (see daemon-csrf.test.ts): /daemon/* is now per-IP rate-limited, so under
// the shared singleWorker runtime each call gets its own source IP to avoid unrelated tests piling
// into one bucket and 429-ing. Merges onto caller headers.
function gw(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', crypto.randomUUID())
  return SELF.fetch(url, { ...init, headers })
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

// A logged-in browser: returns the Cookie header value carrying a real session JWT.
async function browserCookie(userId: string): Promise<string> {
  const { token } = await mintSession(env, {
    userId,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function issueCode(): Promise<{ code: string; expiresAt: number }> {
  const res = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { code: string; expiresAt: number; pollIntervalMs: number }
  expect(typeof body.code).toBe('string')
  expect(body.code.length).toBeGreaterThan(20)
  return { code: body.code, expiresAt: body.expiresAt }
}

// Approve like a real browser would: GET the approve page first to obtain the session+code-bound
// CSRF token (HARDEN §5), then POST it back with the code. A separate suite (daemon-csrf.test.ts)
// proves the token is actually enforced; here we just want the happy-path approval to go through.
async function approve(code: string, cookie: string): Promise<Response> {
  const page = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
    headers: { Cookie: cookie },
  })
  const csrf = (await page.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
  return gw(`${ORIGIN}/daemon/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code, csrf }),
  })
}

async function exchange(code: string, extra?: Record<string, unknown>): Promise<Response> {
  return gw(`${ORIGIN}/daemon/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, ...extra }),
  })
}

describe('happy path: issue -> approve (logged-in) -> exchange', () => {
  test('daemon gets a long-term token bound to the approving user', async () => {
    const userId = await makeUser('happy')
    const cookie = await browserCookie(userId)
    const { code } = await issueCode()

    const ap = await approve(code, cookie)
    expect(ap.status).toBe(200)

    const ex = await exchange(code)
    expect(ex.status).toBe(200)
    const body = (await ex.json()) as { daemonId: string; daemonToken: string }
    expect(typeof body.daemonId).toBe('string')
    expect(typeof body.daemonToken).toBe('string')
    expect(body.daemonToken.length).toBeGreaterThan(20)

    // the created daemon belongs to the approver and is live
    const { getLiveDaemonByToken } = await import('../src/db.js')
    const daemon = await getLiveDaemonByToken(env.DB, body.daemonToken)
    expect(daemon).not.toBeNull()
    expect(daemon?.user_id).toBe(userId)
    expect(daemon?.id).toBe(body.daemonId)
  })
})

describe('security invariant #5 — a daemon cannot self-approve', () => {
  test('exchange of an UNAPPROVED code yields no token', async () => {
    const { code } = await issueCode()
    // no approve step at all — the daemon only ever holds the code, never a browser session
    const ex = await exchange(code)
    expect(ex.status).toBe(401)
    const body = (await ex.json().catch(() => ({}))) as { daemonToken?: string }
    expect(body.daemonToken).toBeUndefined()
  })

  test('approve WITHOUT a logged-in session is rejected (no cookie)', async () => {
    const { code } = await issueCode()
    const res = await gw(`${ORIGIN}/daemon/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(res.status).toBe(401)
    // and the code is still unusable afterwards
    expect((await exchange(code)).status).toBe(401)
  })

  test('approve with a forged/garbage session cookie is rejected', async () => {
    const { code } = await issueCode()
    const res = await approve(code, `${SESSION_COOKIE_NAME}=not-a-real-jwt`)
    expect(res.status).toBe(401)
    expect((await exchange(code)).status).toBe(401)
  })
})

describe('single-use + replay', () => {
  test('a code can be exchanged only once (replay yields no second token)', async () => {
    const userId = await makeUser('replay')
    const cookie = await browserCookie(userId)
    const { code } = await issueCode()
    expect((await approve(code, cookie)).status).toBe(200)

    expect((await exchange(code)).status).toBe(200)
    // second exchange of the same code: consumed_at is set, so nothing comes back
    const second = await exchange(code)
    expect(second.status).toBe(401)
    const body = (await second.json().catch(() => ({}))) as { daemonToken?: string }
    expect(body.daemonToken).toBeUndefined()
  })

  test('a code cannot be approved twice', async () => {
    const userId = await makeUser('double-approve')
    const cookie = await browserCookie(userId)
    const { code } = await issueCode()
    expect((await approve(code, cookie)).status).toBe(200)
    // second approve (e.g. attacker re-binding) must fail — already approved
    const second = await approve(code, cookie)
    expect(second.status).toBe(409)
  })
})

describe('cross-account isolation', () => {
  test('user B cannot exchange a code that user A approved? (only the daemon holding the code can)', async () => {
    // The code is the bearer secret; what we assert here is that approval binds the daemon to the
    // APPROVER's account, not to whoever later exchanges. So a token always belongs to the approver.
    const alice = await makeUser('alice')
    const aliceCookie = await browserCookie(alice)
    const { code } = await issueCode()
    expect((await approve(code, aliceCookie)).status).toBe(200)

    const ex = await exchange(code)
    expect(ex.status).toBe(200)
    const body = (await ex.json()) as { daemonId: string }
    const daemon = await env.DB.prepare('SELECT user_id FROM daemons WHERE id = ?1')
      .bind(body.daemonId)
      .first<{
        user_id: string
      }>()
    expect(daemon?.user_id).toBe(alice)
  })
})

describe('unknown / malformed codes', () => {
  test('exchanging a code that was never issued yields 401, no token', async () => {
    const ex = await exchange('totally-made-up-code-value-0000')
    expect(ex.status).toBe(401)
  })

  test('approving a code that was never issued yields a clean rejection (not a token)', async () => {
    const userId = await makeUser('approve-unknown')
    const cookie = await browserCookie(userId)
    const res = await approve('totally-made-up-code-value-1111', cookie)
    // not approvable -> 404/409-class, never 200
    expect(res.status).not.toBe(200)
  })

  test('POST /daemon/code with no body still issues (no auth needed to ask for a code)', async () => {
    const res = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
    expect(res.status).toBe(200)
  })
})

// G3 — optional 'name' in POST /daemon/token
describe('G3: optional name in /daemon/token', () => {
  test('provided name lands in the daemon row', async () => {
    const userId = await makeUser('g3-named')
    const cookie = await browserCookie(userId)
    const { code } = await issueCode()
    expect((await approve(code, cookie)).status).toBe(200)

    const ex = await exchange(code, { name: 'my-laptop' })
    expect(ex.status).toBe(200)
    const body = (await ex.json()) as { daemonId: string; daemonToken: string }
    const { getDaemonById } = await import('../src/db.js')
    const daemon = await getDaemonById(env.DB, body.daemonId)
    expect(daemon?.name).toBe('my-laptop')
  })

  test('malicious/oversized name is clamped and control chars stripped', async () => {
    const userId = await makeUser('g3-clamped')
    const cookie = await browserCookie(userId)
    const { code } = await issueCode()
    expect((await approve(code, cookie)).status).toBe(200)

    // 100-char string with a null byte and a leading control char
    const evil = `\x00${'A'.repeat(100)}`
    const ex = await exchange(code, { name: evil })
    expect(ex.status).toBe(200)
    const body = (await ex.json()) as { daemonId: string }
    const { getDaemonById } = await import('../src/db.js')
    const daemon = await getDaemonById(env.DB, body.daemonId)
    // control chars stripped, result capped at 64 chars
    expect(daemon?.name).toBe('A'.repeat(64))
  })
})
