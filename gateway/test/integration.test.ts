import { env, fetchMock, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { createDevice, getLiveDaemonByToken } from '../src/db.js'
import { GH_FLOW_COOKIE } from '../src/oauth-common.js'
import {
  mintSession,
  PHONE_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  verifySession,
} from '../src/sessions.js'

// END-TO-END WIRING (impl:wiring). The per-module suites prove each piece in isolation; this file
// drives the FULLY ASSEMBLED app (index.ts) through SELF.fetch and chains modules together the way a
// real client does. It catches wiring bugs a module test can't: an OAuth-minted session cookie that
// /machines won't accept, a route mounted in the wrong order, the daemon-binding chain not surfacing
// on the owner's machine list, or /relay not delegating the cross-account rejection. Nothing here is
// a happy-path-only assert — each one fails if the corresponding wiring is broken (verified RED by
// temporarily reversing the index.ts wiring during development).
//
// The gateway does exactly two things, so the three flows below are the milestone in miniature:
//   1. IDENTITY — full GitHub login (mocked provider) -> session cookie -> list machines.
//   2. IDENTITY — daemon code -> browser approve -> token, then the bound machine appears for its owner.
//   3. ROUTING  — a phone reaching a daemonId it doesn't own is rejected at the relay (cross-account).

const ORIGIN = 'https://app.hivehq.dev'

// Every request gets a fresh edge IP. /auth/* and /daemon/* are per-IP rate-limited and the runtime
// is singleWorker, so without this unrelated integration requests would pile into one login/codeExchange
// bucket and spuriously 429. A real browser flow is one IP; the rate-limit suite proves the limit trips.
function gw(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', crypto.randomUUID())
  return SELF.fetch(url, { ...init, headers })
}

// All outbound provider traffic must hit the injected mock URLs; a real-network attempt is a failure
// (proves the env base URLs are honored end-to-end through the wiring).
beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(async () => {
  // No un-consumed interceptors should linger — every mocked provider call must actually be made.
  fetchMock.assertNoPendingInterceptors()
  // Keep daemons/users/codes minted by one integration test from bleeding routing/listing assertions
  // into the next. Fresh random subs per test make this belt-and-suspenders; clear the hot tables.
  await env.DB.exec('DELETE FROM revocations')
})

// workerd Headers has getSetCookie() at runtime but the workers-types Headers type omits it.
function setCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie(): string[] }
  return h.getSetCookie()
}

function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const head = c.split(';')[0] ?? ''
    const eq = head.indexOf('=')
    if (eq === -1) continue
    if (head.slice(0, eq).trim() === name) {
      const v = head.slice(eq + 1).trim()
      return v.length > 0 ? v : null
    }
  }
  return null
}

// ---- mock GitHub provider (token + identity) -----------------------------
// Registered with this file's fetchMock (activated in beforeAll). Account id becomes provider_sub.
function mockGithub(accountId: number, opts: { login?: string; name?: string } = {}): void {
  const gh = fetchMock.get('https://mock.test')
  gh.intercept({ path: (p) => p.startsWith('/gh/login/oauth/access_token'), method: 'POST' }).reply(
    200,
    JSON.stringify({ access_token: 'gh-access-token', token_type: 'bearer' }),
    { headers: { 'content-type': 'application/json' } }
  )
  gh.intercept({ path: (p) => p.startsWith('/gh/api/user/emails'), method: 'GET' }).reply(
    200,
    JSON.stringify([{ email: 'octo@example.com', primary: true, verified: true }]),
    { headers: { 'content-type': 'application/json' } }
  )
  gh.intercept({
    path: (p) => p.startsWith('/gh/api/user') && !p.startsWith('/gh/api/user/emails'),
    method: 'GET',
  }).reply(
    200,
    JSON.stringify({
      id: accountId,
      login: opts.login ?? 'octocat',
      name: opts.name ?? 'Octo Cat',
    }),
    { headers: { 'content-type': 'application/json' } }
  )
}

// Drive a GitHub authorize step, returning the state + the flow cookie the browser would echo back.
async function ghAuthorize(): Promise<{ state: string; flowCookie: string }> {
  const res = await gw(`${ORIGIN}/auth/github`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const flow = cookieValue(res, GH_FLOW_COOKIE)
  expect(flow).not.toBeNull()
  const loc = new URL(res.headers.get('Location') ?? '', ORIGIN)
  const state = loc.searchParams.get('state') ?? ''
  expect(state.length).toBeGreaterThan(16)
  return { state, flowCookie: `${GH_FLOW_COOKIE}=${flow}` }
}

// Complete a full GitHub login and return the session cookie header value the browser would carry.
async function loginViaGithub(
  accountId: number
): Promise<{ sessionCookie: string; userId: string }> {
  mockGithub(accountId)
  const { state, flowCookie } = await ghAuthorize()
  const cb = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
    headers: { Cookie: flowCookie },
    redirect: 'manual',
  })
  expect(cb.status).toBe(302)
  const session = cookieValue(cb, SESSION_COOKIE_NAME)
  expect(session).not.toBeNull()
  const claims = await verifySession(env, session ?? '')
  expect(claims).not.toBeNull()
  return { sessionCookie: `${SESSION_COOKIE_NAME}=${session}`, userId: claims?.userId ?? '' }
}

// =========================================================================
// Flow 1 — IDENTITY: full GitHub login -> session cookie -> list machines
// =========================================================================

describe('e2e: GitHub login -> session cookie -> /machines', () => {
  test('the OAuth-minted session cookie is accepted by /machines (oauth -> sessions -> pages wired)', async () => {
    const { sessionCookie } = await loginViaGithub(110001)

    // The SAME cookie the callback set must authenticate the protected page. If the login bounce, the
    // pages mount, or the session-cookie name/verify were wired wrong, this 302s to /?redirect=… .
    const machines = await gw(`${ORIGIN}/machines`, {
      headers: { Cookie: sessionCookie },
      redirect: 'manual',
    })
    expect(machines.status).toBe(200)
    const body = await machines.text()
    expect(body).toContain('Your machines')
    // Fresh account: no machines yet (proves we rendered THIS account's empty list, not a 302/login).
    expect(body).toContain('No machines linked yet.')
  })

  test('without the cookie the same /machines request bounces to login (gate is real, not bypassed)', async () => {
    // Sanity counter-test: the protected page is genuinely gated. If /machines were mounted before its
    // session check (or the check removed), this would 200 instead of redirecting.
    const res = await gw(`${ORIGIN}/machines`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect((res.headers.get('Location') ?? '').startsWith('/?redirect=')).toBe(true)
  })

  test('GET / with the logged-in cookie redirects to /machines (login page never shown to authed user)', async () => {
    const { sessionCookie } = await loginViaGithub(110002)
    const res = await gw(`${ORIGIN}/`, { headers: { Cookie: sessionCookie }, redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/machines')
  })
})

// =========================================================================
// Flow 2 — IDENTITY: daemon code -> browser approve -> token -> shows on owner machine list
// =========================================================================

describe('e2e: daemon code -> approve -> token, bound machine appears for its owner', () => {
  test('full binding chain produces an owner-scoped daemon visible on /machines', async () => {
    // The approver logs in for real (not a hand-minted session) — exercises the whole identity stack.
    const { sessionCookie, userId } = await loginViaGithub(120001)

    // 1) daemon mints a one-time code (no auth).
    const codeRes = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
    expect(codeRes.status).toBe(200)
    const { code } = (await codeRes.json()) as { code: string }
    expect(code.startsWith('hc_')).toBe(true)

    // 2) the logged-in browser opens the approve page, reads the session+code-bound CSRF token, and
    //    POSTs it back. This is the real ceremony — a daemon (no session) could not do this.
    const page = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: sessionCookie },
    })
    expect(page.status).toBe(200)
    const csrf = (await page.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
    expect(csrf.length).toBeGreaterThan(0)
    const approve = await gw(`${ORIGIN}/daemon/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ code, csrf }),
    })
    expect(approve.status).toBe(200)

    // 3) the daemon (no session) exchanges the approved code for its long-term token, once.
    const tokenRes = await gw(`${ORIGIN}/daemon/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(tokenRes.status).toBe(200)
    const { daemonId, daemonToken } = (await tokenRes.json()) as {
      daemonId: string
      daemonToken: string
    }

    // The minted daemon is bound to the APPROVER's account (not whoever exchanged) and is live.
    const daemon = await getLiveDaemonByToken(env.DB, daemonToken)
    expect(daemon?.user_id).toBe(userId)
    expect(daemon?.id).toBe(daemonId)

    // 4) and it surfaces on the approver's machine list — the binding flow integrates with pages.
    const machines = await gw(`${ORIGIN}/machines`, {
      headers: { Cookie: sessionCookie },
      redirect: 'manual',
    })
    expect(machines.status).toBe(200)
    const body = await machines.text()
    expect(body).toContain('New machine') // the default daemon name
    expect(body).not.toContain('No machines linked yet.')
  })

  test('the bound machine does NOT appear for a DIFFERENT account (binding is owner-scoped end-to-end)', async () => {
    const owner = await loginViaGithub(120002)
    const codeRes = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
    const { code } = (await codeRes.json()) as { code: string }
    const page = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: owner.sessionCookie },
    })
    const csrf = (await page.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
    await gw(`${ORIGIN}/daemon/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: owner.sessionCookie },
      body: JSON.stringify({ code, csrf }),
    })
    const tokenRes = await gw(`${ORIGIN}/daemon/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(tokenRes.status).toBe(200)

    // A second, unrelated account logs in. The owner's freshly-bound daemon must NOT be in its list.
    const other = await loginViaGithub(120003)
    const machines = await gw(`${ORIGIN}/machines`, {
      headers: { Cookie: other.sessionCookie },
      redirect: 'manual',
    })
    expect(machines.status).toBe(200)
    const body = await machines.text()
    expect(body).toContain('No machines linked yet.')
  })
})

// =========================================================================
// Flow 3 — ROUTING: phone connect rejected for a foreign daemonId
// =========================================================================

describe('e2e: phone WS connect rejected for a daemonId it does not own', () => {
  // Bind a daemon to one account via the REAL flow, then have a second logged-in account try to open a
  // /relay device socket against that daemonId. The relay must reject (no 101) and the owner's DO must
  // never see a device attach. This is the headline cross-account IDOR (#3) proven through the wired
  // route, not by calling relayConnect directly.
  test('foreign daemonId -> no 101, owner DO never gains a device socket', async () => {
    // Owner binds a real daemon.
    const owner = await loginViaGithub(130001)
    const codeRes = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
    const { code } = (await codeRes.json()) as { code: string }
    const page = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: owner.sessionCookie },
    })
    const csrf = (await page.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
    await gw(`${ORIGIN}/daemon/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: owner.sessionCookie },
      body: JSON.stringify({ code, csrf }),
    })
    const tokenRes = await gw(`${ORIGIN}/daemon/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const { daemonId, daemonToken } = (await tokenRes.json()) as {
      daemonId: string
      daemonToken: string
    }

    // Owner's daemon comes online (real daemon-side WS upgrade through the wired route).
    const daemonUpgrade = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${daemonToken}`,
      },
    })
    expect(daemonUpgrade.status).toBe(101)
    const daemonWs = daemonUpgrade.webSocket
    expect(daemonWs).toBeTruthy()
    daemonWs?.accept()

    // Wait until the daemon socket has actually attached in the owner's DO before the foreign attempt.
    // On a cold runtime the daemon upgrade and the next /relay request can race through the shared
    // workerd runtime; this barrier removes that timing artifact so the cross-account ownership check
    // is unambiguously what rejects the attacker, not a half-settled DO. (It also makes the later
    // "owner DO never gained a device socket" assertion meaningful — the owner's DO is awake.)
    const ownerStubReady = env.RELAY.get(env.RELAY.idFromName(owner.userId))
    await runInDurableObject(ownerStubReady, async (_i, s) => {
      expect(s.getWebSockets(`daemon:${daemonId}`).length).toBe(1)
    })

    // A DIFFERENT logged-in account presents a phone session targeting the OWNER's daemonId. The phone
    // session is hand-minted WITH a did (paired-device session) so the request clears the device gate
    // and the ONLY thing that can stop it is the cross-account ownership check.
    const attacker = await loginViaGithub(130002)
    const attackerDeviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: attackerDeviceId,
      userId: attacker.userId,
      name: 'Attacker Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token: attackerPhone } = await mintSession(env, {
      userId: attacker.userId,
      deviceId: attackerDeviceId,
      ttlMs: PHONE_SESSION_TTL_MS,
    })

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(daemonId)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${attackerPhone}`,
      },
    })
    // The ownership gate rejects with a hard 403 (relayDevice) — assert that exact code, not just
    // "not 101", so a regression that 500s or silently 101s after a partial check still bites.
    expect(res.status).toBe(403)
    expect(res.webSocket).toBeFalsy()

    // The owner's per-account DO must never have gained a device socket from the foreign attempt.
    const ownerDevices = await runInDurableObject(
      ownerStubReady,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(ownerDevices).toBe(0)

    // And the attacker's OWN DO never gained one either (the daemon isn't theirs to bridge to).
    const attackerStub = env.RELAY.get(env.RELAY.idFromName(attacker.userId))
    const attackerDevices = await runInDurableObject(
      attackerStub,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(attackerDevices).toBe(0)

    daemonWs?.close()
  })

  test('the SAME phone session reaching its OWN daemonId is accepted (rejection is ownership, not blanket-deny)', async () => {
    // Counter-test so flow 3 above can't pass by rejecting everything. The owner's own paired phone
    // connecting to the owner's own live daemon must get a 101.
    const owner = await loginViaGithub(130003)
    const codeRes = await gw(`${ORIGIN}/daemon/code`, { method: 'POST' })
    const { code } = (await codeRes.json()) as { code: string }
    const page = await gw(`${ORIGIN}/daemon/approve?code=${encodeURIComponent(code)}`, {
      headers: { Cookie: owner.sessionCookie },
    })
    const csrf = (await page.text()).match(/name="csrf"\s+value="([^"]+)"/)?.[1] ?? ''
    await gw(`${ORIGIN}/daemon/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: owner.sessionCookie },
      body: JSON.stringify({ code, csrf }),
    })
    const tokenRes = await gw(`${ORIGIN}/daemon/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const { daemonId, daemonToken } = (await tokenRes.json()) as {
      daemonId: string
      daemonToken: string
    }

    const daemonUpgrade = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${daemonToken}`,
      },
    })
    expect(daemonUpgrade.status).toBe(101)
    daemonUpgrade.webSocket?.accept()

    const ownerDeviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: ownerDeviceId,
      userId: owner.userId,
      name: 'Owner Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token: ownerPhone } = await mintSession(env, {
      userId: owner.userId,
      deviceId: ownerDeviceId,
      ttlMs: PHONE_SESSION_TTL_MS,
    })

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(daemonId)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${ownerPhone}`,
      },
    })
    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
    res.webSocket?.accept()
    res.webSocket?.close()
    daemonUpgrade.webSocket?.close()
  })
})
