// Server-rendered, public-safe HTML pages: login, machine-list, pairing-guide, /privacy, /terms, plus
// the shared /styles.css. These are minimal by design — the rich mobile UI ships as the /app bundle —
// but they still wear Hive's skin (page-shell.ts + the served stylesheet), not browser defaults.
//
// SECURITY:
//   - Every HTML response carries HTML_SECURITY_HEADERS (frame-busting + nosniff + no-referrer) so a
//     page can't be clickjacked and an OAuth ?code/?state can't leak via Referer (HARDEN §4/§7.2).
//   - Styling is a same-origin /styles.css (no inline <style>, no inline style="" attrs, no inline
//     scripts, no third-party origins), so the baseline CSP (default-src 'self') holds unchanged.
//     Provider marks are inline SVG (document markup, not external resources — CSP-safe).
//   - /machines + /pair require a verified session; logged-out callers bounce to login with a return
//     path (validateRedirect-allowlisted, in-app only — no open redirect).
//   - Every dynamic value (machine/device name, timestamps) is HTML-escaped. No secret is ever
//     rendered (the hygiene suite greps for the sentinels).

import { Hono } from 'hono'
import { HTML_SECURITY_HEADERS } from './daemon.js'
import { getDaemonsForUser, getDevicesForUser, revokeSession } from './db.js'
import type { Env } from './env.js'
import { validateRedirect } from './oauth-common.js'
import { escapeHtml, PAGE_STYLES, renderShell } from './page-shell.js'
import { clearSessionCookie, readSessionCookie, sessionFromRequest } from './sessions.js'

// Re-exported for any caller that historically imported it from here (canonical impl in page-shell).
export { escapeHtml }

// Inline provider marks. GitHub inherits currentColor; Google keeps its brand quadrants (path-level
// fill presentation attributes beat the inherited .ico fill).
const GITHUB_MARK =
  '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'
const GOOGLE_MARK =
  '<svg class="ico" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>'

export const pageRoutes = new Hono<{ Bindings: Env }>()

// The shared stylesheet. Same-origin (CSP style-src falls back to default-src 'self'), cacheable, no
// secrets — so it does not carry the HTML security headers (it isn't HTML).
pageRoutes.get('/styles.css', (c) =>
  c.body(PAGE_STYLES, 200, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
)

// Whitelisted reason codes that may be echoed on the login page (G5). Unknown values are dropped.
const VALID_REASONS = new Set(['expired'])

// Login. Logged-in users skip it (straight to the machine list); everyone else gets the two OAuth
// entry points (no passwords).
pageRoutes.get('/', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  if (session !== null) return c.redirect('/machines', 302)

  // Carry an incoming (validated) return path through the OAuth round-trip so a user who arrived here
  // from a session-gated link (e.g. the daemon-approve URL, or the /app shell) lands back there after
  // signing in, not on the default machine list. validateRedirect collapses anything off the allowlist
  // to '/'; we then default the post-login landing to /machines. The path is URL-encoded into both
  // provider hrefs (encodeURIComponent leaves no HTML-special chars, so the attribute is safe).
  const dest = validateRedirect(c.env, c.req.query('redirect') ?? null)
  const rq = encodeURIComponent(dest === '/' ? '/machines' : dest)

  // G5 — whitelisted reason echoed as a muted note; unknown values are silently dropped (no XSS).
  const rawReason = c.req.query('reason') ?? ''
  const reason = VALID_REASONS.has(rawReason) ? rawReason : ''
  const reasonHtml =
    reason === 'expired' ? '<p class="muted reason">Your session expired — sign in again.</p>' : ''

  // Hero sign-in: the bird is the brand moment (renderShell drops its small
  // header via the hero flag so the mark appears exactly once).
  const body = `<div class="hero"><img class="hero__mark" src="/brand/icon-192.png" width="64" height="64" alt=""><h1 class="hero__name">Hive</h1><p class="hero__tag">Your agent team, from anywhere.</p></div>
  ${reasonHtml}<a class="btn btn--primary" href="/auth/github?redirect=${rq}">${GITHUB_MARK}Continue with GitHub</a>
  <a class="btn" href="/auth/google?redirect=${rq}">${GOOGLE_MARK}Continue with Google</a>`
  return c.html(renderShell('Sign in · Hive', body, { hero: true }), 200, HTML_SECURITY_HEADERS)
})

// Machine list (device management). Session required. Lists the caller account's daemons + devices
// only — getDaemonsForUser/getDevicesForUser are user_id-scoped, so there is no cross-account leak.
pageRoutes.get('/machines', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  if (session === null) {
    // G5 — carry reason=expired when a stale/revoked cookie was present.
    const reason = readSessionCookie(c.req.raw) !== null ? '&reason=expired' : ''
    return c.redirect(`/?redirect=${encodeURIComponent('/machines')}${reason}`, 302)
  }

  const [daemons, devices] = await Promise.all([
    getDaemonsForUser(c.env.DB, session.userId),
    getDevicesForUser(c.env.DB, session.userId),
  ])

  // G2 — mirror pair.ts: query the DO's liveDaemonIds() rather than relying on last_seen != null.
  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(session.userId))
  const live = new Set(await stub.liveDaemonIds())

  const daemonRows = daemons
    .map((d) => {
      const state = d.revoked_at !== null ? 'revoked' : live.has(d.id) ? 'online' : 'idle'
      const dot = state === 'online' ? 'dot--on' : state === 'revoked' ? 'dot--bad' : 'dot--off'
      const seen = d.last_seen !== null ? formatTime(d.last_seen) : 'never'
      return `<li class="row"><span class="dot ${dot}" aria-hidden="true"></span><span class="row__main"><span class="row__name">${escapeHtml(
        d.name
      )}</span><span class="row__meta">${escapeHtml(state)} · last seen ${escapeHtml(
        seen
      )}</span></span></li>`
    })
    .join('')

  const deviceRows = devices
    .map((dev) => {
      const revoked = dev.revoked_at !== null
      const dot = revoked ? 'dot--bad' : 'dot--on'
      return `<li class="row"><span class="dot ${dot}" aria-hidden="true"></span><span class="row__main"><span class="row__name">${escapeHtml(
        dev.name
      )}</span><span class="row__meta">${escapeHtml(revoked ? 'revoked' : 'active')}</span></span></li>`
    })
    .join('')

  const body = `<h1>Your machines</h1>
  <p class="sub">Daemons and phones linked to your account.</p>
  <div class="sect"><div class="sect__h">Machines</div><ul class="list">${
    daemonRows || '<li class="empty">No machines linked yet.</li>'
  }</ul></div>
  <div class="sect"><div class="sect__h">Devices</div><ul class="list">${
    deviceRows || '<li class="empty">No devices paired yet.</li>'
  }</ul></div>
  <div class="divider"></div>
  <a class="btn btn--primary" href="/pair">Pair a phone</a>
  <a class="btn" href="/app">Already paired? Open Hive</a>
  <div class="signout"><form method="POST" action="/logout"><button type="submit" class="btn">Sign out</button></form></div>`
  return c.html(renderShell('Your machines · Hive', body), 200, HTML_SECURITY_HEADERS)
})

// Pairing guide. Session required. Static instructions; the live pairing UI is the /app bundle —
// the primary CTA below MUST link there or the phone is stranded in these server-rendered pages.
pageRoutes.get('/pair', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  if (session === null) {
    const reason = readSessionCookie(c.req.raw) !== null ? '&reason=expired' : ''
    return c.redirect(`/?redirect=${encodeURIComponent('/pair')}${reason}`, 302)
  }

  const body = `<h1>Pair a phone</h1>
  <p class="sub">Link a phone as an equal-authority device.</p>
  <ol class="steps">
    <li>On your computer, open Hive → Settings → Remote access → Add device.</li>
    <li>Tap <strong>Start pairing</strong> below and pick your machine.</li>
    <li>Enter the code from your computer, then confirm the matching 6-digit number there.</li>
  </ol>
  <div class="note">Pairing is approved on your computer — a phone can never approve itself. The gateway only relays ciphertext.</div>
  <a class="btn btn--primary" href="/app">Start pairing</a>
  <a class="btn" href="/machines">Back to machines</a>`
  return c.html(renderShell('Pair a phone · Hive', body), 200, HTML_SECURITY_HEADERS)
})

// Static privacy policy — required for Google OAuth production verification. Public, no session.
pageRoutes.get('/privacy', (c) => {
  const body = `<div class="legal">
  <h1>Privacy Policy</h1>
  <p>Hive is a relay between your phone and your own machine. The gateway handles sign-in and routes
  encrypted traffic; it never decrypts your terminal or API content, and your data and code stay on
  your machine.</p>
  <p>We store only what identity and routing require: your provider account id, an informational
  email, the machines and devices you link, and session metadata. We do not sell your data.</p>
  <p class="muted"><a href="/">← Home</a></p>
  </div>`
  return c.html(renderShell('Privacy Policy · Hive', body), 200, HTML_SECURITY_HEADERS)
})

// Static terms of service — required for Google OAuth production verification. Public, no session.
pageRoutes.get('/terms', (c) => {
  const body = `<div class="legal">
  <h1>Terms of Service</h1>
  <p>Hive is provided as-is for connecting to machines you control. You are responsible for the
  machines you link and the commands you run through them. Do not use Hive to access systems you are
  not authorized to use.</p>
  <p class="muted"><a href="/">← Home</a></p>
  </div>`
  return c.html(renderShell('Terms of Service · Hive', body), 200, HTML_SECURITY_HEADERS)
})

// G4 — sign-out. Clears the cookie and revokes the jti in the deny-list so re-verifying the old
// JWT yields null. Redirects to login; no sensitive redirect path carried (no open-redirect).
pageRoutes.post('/logout', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  if (session !== null) {
    await revokeSession(c.env.DB, {
      jti: session.jti,
      userId: session.userId,
      now: Date.now(),
      reason: 'logout',
    })
  }
  const res = c.redirect('/', 302)
  res.headers.set('Set-Cookie', clearSessionCookie())
  return res
})

// G1 — compact relative timestamp. Falls back to YYYY-MM-DD past 7 days.
function formatTime(ms: number): string {
  try {
    const diffMs = Date.now() - ms
    if (diffMs < 0) return new Date(ms).toISOString().slice(0, 10)
    if (diffMs < 60_000) return 'just now'
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
    if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`
    return new Date(ms).toISOString().slice(0, 10)
  } catch {
    return 'unknown'
  }
}
