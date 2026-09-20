import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, test } from 'vitest'
import { createDaemon, upsertUser } from '../src/db.js'
import { escapeHtml } from '../src/pages.js'
import { BROWSER_SESSION_TTL_MS, mintSession, SESSION_COOKIE_NAME } from '../src/sessions.js'

// Public-safe server-rendered HTML: login, machine-list, pairing-guide, /privacy, /terms. These must
// (a) gate the authenticated pages behind a real session, (b) HTML-escape every dynamic value so a
// crafted machine name can't inject markup, (c) ship the anti-clickjacking / nosniff headers on ALL
// HTML, and (d) NEVER render a secret (the sentinel-leak guard). privacy/terms are static + public
// (Google brand verification). Each assert is written to fail on the obvious broken impl.

const ORIGIN = 'https://app.hivehq.dev'
const SENTINELS = [env.JWT_SIGNING_SECRET, env.GITHUB_CLIENT_SECRET, env.GOOGLE_CLIENT_SECRET]

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

function expectHtmlSecurityHeaders(res: Response): void {
  // HARDEN §4/§7.2 — every HTML response carries the systemic headers. frame-busting (DENY +
  // frame-ancestors 'none'), nosniff, no-referrer (so ?code/?state can't leak via Referer).
  expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  const csp = res.headers.get('Content-Security-Policy') ?? ''
  expect(csp).toContain("frame-ancestors 'none'")
}

function expectNoSecret(body: string, res: Response): void {
  const cookie = res.headers.get('Set-Cookie') ?? ''
  for (const s of SENTINELS) {
    expect(body).not.toContain(s)
    expect(cookie).not.toContain(s)
  }
}

afterEach(async () => {
  await env.DB.exec('DELETE FROM revocations')
})

describe('GET / (login)', () => {
  test('logged-out → login page with both provider sign-in links + security headers', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html')
    const body = await res.text()
    // both OAuth entry points are linked (the only way in — no passwords)
    expect(body).toContain('/auth/github')
    expect(body).toContain('/auth/google')
    expectHtmlSecurityHeaders(res)
    expectNoSecret(body, res)
  })

  test('logged-in → redirected to /machines (no login form shown to an authed user)', async () => {
    const userId = await makeUser('login-redirect')
    const cookie = await browserCookie(userId)
    const res = await SELF.fetch(`${ORIGIN}/`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/machines')
  })

  test('an allowlisted ?redirect is carried into BOTH provider links (return path survives sign-in)', async () => {
    // A logged-out user who arrived from the daemon-approve link must leave login back to that page,
    // not the default machine list. The login page threads its ?redirect into the OAuth hrefs so the
    // value rides the OAuth state and the callback lands there. Mutation: hardcode /machines again and
    // the approve return path stops appearing here.
    const back = '/daemon/approve?code=hc_returnpath'
    const res = await SELF.fetch(`${ORIGIN}/?redirect=${encodeURIComponent(back)}`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`/auth/github?redirect=${encodeURIComponent(back)}`)
    expect(body).toContain(`/auth/google?redirect=${encodeURIComponent(back)}`)
  })

  test('an OFF-allowlist ?redirect collapses to the default landing (no open redirect into the links)', async () => {
    // validateRedirect must neutralize a hostile redirect BEFORE it reaches the hrefs.
    const res = await SELF.fetch(`${ORIGIN}/?redirect=${encodeURIComponent('https://evil.com')}`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('/auth/github?redirect=%2Fmachines')
    expect(body).not.toContain('evil.com')
  })
})

describe('GET /styles.css (shared stylesheet)', () => {
  test('serves CSS same-origin (so CSP default-src self holds) with a long cache', async () => {
    const res = await SELF.fetch(`${ORIGIN}/styles.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('text/css')
    expect(res.headers.get('Cache-Control') ?? '').toContain('max-age')
    const css = await res.text()
    // real stylesheet, not an empty stub — the classes the pages actually use must be defined
    expect(css).toContain('.btn--primary')
    expect(css).toContain('--accent')
  })

  test('the login page links the stylesheet (pages are styled, not browser-default)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { redirect: 'manual' })
    const body = await res.text()
    expect(body).toContain('<link rel="stylesheet" href="/styles.css">')
  })
})

describe('GET /machines (session required)', () => {
  test('logged-out → redirect to login with a return path (not the machine list)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/machines`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location') ?? ''
    // must bounce to login, carrying where to come back to
    expect(loc.startsWith('/?redirect=')).toBe(true)
    expect(loc).toContain(encodeURIComponent('/machines'))
  })

  test('logged-in → lists ONLY the caller account daemons, HTML-escaped, no secret', async () => {
    const userId = await makeUser('machines-owner')
    const cookie = await browserCookie(userId)
    // a machine whose name contains markup — must be escaped, not injected
    await createDaemon(env.DB, {
      id: crypto.randomUUID(),
      userId,
      name: '<script>alert(1)</script>',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })

    const res = await SELF.fetch(`${ORIGIN}/machines`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    // escaped, not raw — the literal <script> tag must NOT appear
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
    expectHtmlSecurityHeaders(res)
    expectNoSecret(body, res)
  })

  test('account isolation — A does not see B machines in the list', async () => {
    const alice = await makeUser('machines-alice')
    const bob = await makeUser('machines-bob')
    await createDaemon(env.DB, {
      id: crypto.randomUUID(),
      userId: bob,
      name: 'bobs-secret-laptop',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })
    const res = await SELF.fetch(`${ORIGIN}/machines`, {
      redirect: 'manual',
      headers: { Cookie: await browserCookie(alice) },
    })
    const body = await res.text()
    expect(body).not.toContain('bobs-secret-laptop')
  })
})

describe('GET /pair (session required)', () => {
  test('logged-out → redirect to login', async () => {
    const res = await SELF.fetch(`${ORIGIN}/pair`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect((res.headers.get('Location') ?? '').startsWith('/?redirect=')).toBe(true)
  })

  test('logged-in → pairing guide HTML with security headers', async () => {
    const userId = await makeUser('pair-user')
    const res = await SELF.fetch(`${ORIGIN}/pair`, {
      redirect: 'manual',
      headers: { Cookie: await browserCookie(userId) },
    })
    expect(res.status).toBe(200)
    expectHtmlSecurityHeaders(res)
  })
})

describe('/privacy and /terms (static, public, no session)', () => {
  test('/privacy is public HTML with security headers + no secret', async () => {
    const res = await SELF.fetch(`${ORIGIN}/privacy`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('privacy')
    expectHtmlSecurityHeaders(res)
    expectNoSecret(body, res)
  })

  test('/terms is public HTML with security headers + no secret', async () => {
    const res = await SELF.fetch(`${ORIGIN}/terms`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.toLowerCase()).toContain('terms')
    expectHtmlSecurityHeaders(res)
    expectNoSecret(body, res)
  })
})

describe('escapeHtml', () => {
  test('escapes the markup-significant characters', () => {
    expect(escapeHtml('<b>"x"&\'</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;')
  })
})

// G9 — the machine-list JSON endpoint the phone connect-flow calls. Account-isolated (caller's own
// daemons only) and opaque (DO reports only which of those daemonIds are live). Logged-out → 401.
describe('GET /pair/machines (JSON machine list)', () => {
  test('logged-out → 401', async () => {
    const res = await SELF.fetch(`${ORIGIN}/pair/machines`)
    expect(res.status).toBe(401)
  })

  test('lists ONLY the caller account daemons; self.deviceId surfaces the paired state', async () => {
    const alice = await makeUser('machines-json-alice')
    const bob = await makeUser('machines-json-bob')
    const aliceCookie = await browserCookie(alice)

    const a1 = crypto.randomUUID()
    const a2 = crypto.randomUUID()
    await createDaemon(env.DB, {
      id: a1,
      userId: alice,
      name: 'alice-laptop',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })
    await createDaemon(env.DB, {
      id: a2,
      userId: alice,
      name: 'alice-desktop',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })
    const b1 = crypto.randomUUID()
    await createDaemon(env.DB, {
      id: b1,
      userId: bob,
      name: 'bobs-secret-box',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })

    const res = await SELF.fetch(`${ORIGIN}/pair/machines`, { headers: { Cookie: aliceCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      daemons: Array<{ id: string; name: string; online: boolean; revoked: boolean }>
      self: { deviceId: string | null }
    }
    const ids = body.daemons.map((d) => d.id).sort()
    expect(ids).toEqual([a1, a2].sort())
    // B's daemon never appears in A's list.
    expect(body.daemons.some((d) => d.id === b1)).toBe(false)
    expect(JSON.stringify(body)).not.toContain('bobs-secret-box')
    // a browser-login session is not paired.
    expect(body.self.deviceId).toBeNull()
    // no daemon socket is live → all offline.
    expect(body.daemons.every((d) => d.online === false)).toBe(true)
  })

  test('online is true ONLY for a daemon with a live socket in the caller DO', async () => {
    const userId = await makeUser('machines-json-online')
    const cookie = await browserCookie(userId)
    const liveId = crypto.randomUUID()
    const liveToken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, {
      id: liveId,
      userId,
      name: 'live-box',
      daemonToken: liveToken,
      now: Date.now(),
    })
    const offlineId = crypto.randomUUID()
    await createDaemon(env.DB, {
      id: offlineId,
      userId,
      name: 'offline-box',
      daemonToken: `hd_${crypto.randomUUID()}`,
      now: Date.now(),
    })

    // bring the live daemon up via the real relay path.
    const upRes = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${liveToken}`,
      },
    })
    expect(upRes.status).toBe(101)
    const ws = upRes.webSocket as unknown as WebSocket
    ws.accept()
    // let the socket attach in the DO.
    await new Promise((r) => setTimeout(r, 10))

    const res = await SELF.fetch(`${ORIGIN}/pair/machines`, { headers: { Cookie: cookie } })
    const body = (await res.json()) as { daemons: Array<{ id: string; online: boolean }> }
    const live = body.daemons.find((d) => d.id === liveId)
    const offline = body.daemons.find((d) => d.id === offlineId)
    expect(live?.online).toBe(true)
    expect(offline?.online).toBe(false)
    ws.close()
  })
})

// G4 — POST /logout
describe('POST /logout', () => {
  test('clears the cookie and a subsequent /machines redirects to login', async () => {
    const userId = await makeUser('logout-user')
    const cookie = await browserCookie(userId)

    const res = await SELF.fetch(`${ORIGIN}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    // redirects to /
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
    // cookie is cleared (Max-Age=0)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('Max-Age=0')

    // now the old cookie is revoked — /machines bounces to login
    const after = await SELF.fetch(`${ORIGIN}/machines`, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    })
    expect(after.status).toBe(302)
    expect((after.headers.get('Location') ?? '').startsWith('/?redirect=')).toBe(true)
  })
})

// G5 — reason=expired on login page
describe('G5: reason=expired on login page', () => {
  test('/?reason=expired shows the expiry note (whitelisted value)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/?reason=expired`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('session expired')
  })

  test('/?reason=evil is dropped (unknown value not echoed)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/?reason=evil`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('evil')
  })
})
