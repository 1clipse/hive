import { env, SELF } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { upsertUser } from '../src/db.js'
import { BROWSER_SESSION_TTL_MS, mintSession, SESSION_COOKIE_NAME } from '../src/sessions.js'

// HARDEN §5 — the approve ceremony is the gateway's trust root (binding a daemon = an account-scoped
// token = local RCE). SameSite=Lax blocks a cross-site POST but NOT (a) clickjacking via a frame or
// (b) a same-origin script. These tests prove the two added defenses:
//   1. an unguessable, SESSION-BOUND, code-bound CSRF token gates POST /daemon/approve (forged/absent
//      => 403, no approval) — so a blind cross-site/same-origin POST without the token can't bind;
//   2. every gateway HTML response carries X-Frame-Options: DENY + CSP frame-ancestors 'none' so the
//      approve page can't be framed for clickjacking.
//
// Each assert is written so a reversed impl (skip the token check / drop the header) fails it.

const ORIGIN = 'https://app.hivehq.dev'

// Every request a real client makes carries a distinct edge IP. The gateway now rate-limits
// /daemon/* per IP (CF-Connecting-IP), so under the shared singleWorker runtime we give each fetch a
// fresh source IP — otherwise unrelated tests in this file would pile into one bucket and 429. The
// approve budget is per-ACCOUNT (session), so it isn't affected by the IP; this only frees the
// anonymous /code + /token surfaces. Merges onto any caller-supplied headers.
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

async function browserCookie(userId: string): Promise<string> {
  const { token } = await mintSession(env, {
    userId,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function issueCode(): Promise<string> {
  const res = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
  const body = (await res.json()) as { code: string }
  return body.code
}

// Open the approve page as a logged-in browser and pull the embedded hidden CSRF token out of the
// rendered form. This mirrors exactly what a real browser would submit.
async function fetchApprovePage(code: string, cookie: string): Promise<Response> {
  return gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
    headers: { Cookie: cookie },
  })
}

function extractCsrf(html: string): string | null {
  const m = html.match(/name="csrf"\s+value="([^"]+)"/)
  return m?.[1] ?? null
}

async function postApprove(code: string, cookie: string, csrf: string | null): Promise<Response> {
  const form = new URLSearchParams()
  form.set('code', code)
  if (csrf !== null) form.set('csrf', csrf)
  return gw(`${ORIGIN}/daemon/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form.toString(),
  })
}

async function exchange(code: string): Promise<Response> {
  return gw(`${ORIGIN}/daemon/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
}

describe('HARDEN §5 — approve CSRF token (session-bound, single-use)', () => {
  test('the page embeds a non-empty hidden csrf token and submitting it approves', async () => {
    const cookie = await browserCookie(await makeUser('csrf-happy'))
    const code = await issueCode()

    const page = await fetchApprovePage(code, cookie)
    expect(page.status).toBe(200)
    const csrf = extractCsrf(await page.text())
    expect(csrf).not.toBeNull()
    expect((csrf ?? '').length).toBeGreaterThan(20)

    const ap = await postApprove(code, cookie, csrf)
    expect(ap.status).toBe(200)
    // and now the code is approved and exchangeable
    expect((await exchange(code)).status).toBe(200)
  })

  test('POST /daemon/approve with NO csrf token => 403, no approval (code stays unusable)', async () => {
    const cookie = await browserCookie(await makeUser('csrf-absent'))
    const code = await issueCode()
    const res = await postApprove(code, cookie, null)
    expect(res.status).toBe(403)
    // the code was never approved, so exchange still fails
    expect((await exchange(code)).status).toBe(401)
  })

  test('POST /daemon/approve with a forged/garbage csrf token => 403, no approval', async () => {
    const cookie = await browserCookie(await makeUser('csrf-forged'))
    const code = await issueCode()
    const res = await postApprove(code, cookie, 'totally-bogus-csrf-token-value-0000')
    expect(res.status).toBe(403)
    expect((await exchange(code)).status).toBe(401)
  })

  test('a csrf token minted for ONE code cannot approve a DIFFERENT code (code-bound)', async () => {
    const cookie = await browserCookie(await makeUser('csrf-codebound'))
    const codeA = await issueCode()
    const codeB = await issueCode()

    const csrfA = extractCsrf(await (await fetchApprovePage(codeA, cookie)).text())
    expect(csrfA).not.toBeNull()

    // present codeB's approve with codeA's token
    const res = await postApprove(codeB, cookie, csrfA)
    expect(res.status).toBe(403)
    expect((await exchange(codeB)).status).toBe(401)
  })

  test("a csrf token from victim's session cannot be used from the attacker's session (session-bound)", async () => {
    // The clickjacking/CSRF scenario the blocker describes: an attacker mints a code, then wants to
    // get it approved into the VICTIM's account. A token computed under the attacker's own session
    // must NOT validate when replayed against the victim's session, and vice versa.
    const victim = await browserCookie(await makeUser('csrf-victim'))
    const attacker = await browserCookie(await makeUser('csrf-attacker'))
    const code = await issueCode() // attacker-minted code (anonymous endpoint)

    // attacker reads the token their OWN session would get for this code
    const attackerCsrf = extractCsrf(await (await fetchApprovePage(code, attacker)).text())
    expect(attackerCsrf).not.toBeNull()

    // attacker tries to drive the victim's session to approve using the attacker-derived token
    const res = await postApprove(code, victim, attackerCsrf)
    expect(res.status).toBe(403)
    // victim's account is untouched: the code never got approved
    expect((await exchange(code)).status).toBe(401)
  })

  test('a valid csrf token cannot be replayed to re-approve (already-approved => 409)', async () => {
    const cookie = await browserCookie(await makeUser('csrf-replay'))
    const code = await issueCode()
    const csrf = extractCsrf(await (await fetchApprovePage(code, cookie)).text())

    expect((await postApprove(code, cookie, csrf)).status).toBe(200)
    // replay the exact same valid token: the code is already approved, so no second binding
    const replay = await postApprove(code, cookie, csrf)
    expect(replay.status).toBe(409)
  })

  test('GET /daemon/approve without a session => bounces to login with a return path (no dead-end, no leaked token)', async () => {
    const code = await issueCode()
    // Don't follow the redirect — assert it lands the unauthenticated viewer on the login chooser
    // carrying a return path back to THIS approve URL, so signing in isn't a dead-end (was a bare 401).
    const res = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=not-a-real-jwt` },
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location') ?? ''
    expect(loc.startsWith('/?redirect=')).toBe(true)
    expect(loc).toContain(encodeURIComponent('/daemon/approve'))
    expect(loc).toContain(encodeURIComponent(code)) // the code survives the round-trip
    // still no usable CSRF token handed to an unauthenticated viewer (it's session-bound)
    const csrf = extractCsrf(await res.text().catch(() => ''))
    expect(csrf).toBeNull()
  })
})

describe('HARDEN §5 — clickjacking defense (frame-busting headers on gateway HTML)', () => {
  test('the approve page is served with X-Frame-Options: DENY and CSP frame-ancestors none', async () => {
    const cookie = await browserCookie(await makeUser('csrf-headers'))
    const code = await issueCode()
    const page = await fetchApprovePage(code, cookie)
    expect(page.status).toBe(200)
    expect(page.headers.get('X-Frame-Options')).toBe('DENY')
    const csp = page.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
