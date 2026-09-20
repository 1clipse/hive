// Daemon binding flow — security invariant #5. A local Hive daemon turns a short-lived, one-time
// code into a long-term daemon token ONLY after a logged-in human approves it in their browser. The
// daemon never gets a session, so it can never self-approve: minting requires a session cookie the
// daemon doesn't have. The token's secret is shown exactly once; the DB only ever holds its hash.
//
// State machine (rows in daemon_codes; see migrations/0001_init.sql + db.ts):
//
//   POST /daemon/code      issued      no auth        -> { code, expiresAt, pollIntervalMs }
//   GET  /daemon/approve   issued      browser session -> confirm page (shows the code + CSRF token)
//   POST /daemon/approve   issued      browser session -> approved   (binds user_id + approved_at)
//   POST /daemon/token     approved    holds code      -> exchanged  (creates daemon + token, ONCE)
//
// Any code that is expired / unapproved / already consumed yields NO token (401). Approval needs a
// valid session (401 without one). Re-approval of an already-approved code is rejected (409).
//
// HARDEN §5 — this is the gateway's trust root: binding a daemon mints an account-scoped token that
// is local RCE on the user's machine. SameSite=Lax on the session cookie blocks a cross-site POST,
// but NOT (a) clickjacking via a frame or (b) a same-origin script. Two extra defenses close that:
//   1. An unguessable CSRF token gates POST /daemon/approve. It is HMAC(JWT_SIGNING_SECRET,
//      "daemon-approve:" + session.jti + ":" + code) — bound to BOTH the approver's session (jti)
//      and the exact code. GET embeds it as a hidden field; POST recomputes and constant-time
//      compares. A blind cross-site/same-origin POST that can't read the GET response can't forge it;
//      a token minted under the attacker's session won't validate against the victim's. Replay buys
//      nothing because the first approve flips the code to already-approved (=> 409).
//   2. All gateway HTML ships X-Frame-Options: DENY + CSP frame-ancestors 'none' so the approve page
//      can't be framed for a clickjacking trick.

import { Hono } from 'hono'
import {
  approveDaemonCode,
  consumeApprovedDaemonCode,
  createDaemon,
  createDaemonCode,
  linkDaemonCode,
} from './db.js'
import type { Env } from './env.js'
import { escapeHtml, renderShell } from './page-shell.js'
import { sessionFromRequest } from './sessions.js'

// One-time code lives ~10 min: long enough for the user to walk to their browser + log in, short
// enough that a shoulder-surfed code is dead before it's useful. Daemon polls /daemon/token at the
// suggested interval until the human approves (or the code expires).
export const DAEMON_CODE_TTL_MS = 10 * 60 * 1000
export const DAEMON_CODE_POLL_MS = 2000

// 32 bytes of CSPRNG entropy, base64url. Code and token differ only in prefix so logs can tell them
// apart without revealing either (both are hashed before storage).
function randomSecret(prefix: string): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  const b64 = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${prefix}${b64}`
}

// Default label until the user renames the machine in the device-management UI.
function defaultDaemonName(): string {
  return 'New machine'
}

// HARDEN §5 — anti-clickjacking headers for every HTML response the gateway serves. DENY + an
// explicit frame-ancestors 'none' (some engines honor only one) makes framing the approve page
// impossible, so the clickjacking variant of the trust-root attack can't run even if the victim is
// logged in. nosniff stops content-type confusion on the served HTML.
export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

// Domain separator so this HMAC can never be confused with the session/flow-state JWTs that share
// JWT_SIGNING_SECRET. The token binds the approve action to BOTH the approving session (jti) and the
// specific code, so it's worthless minted under any other session or for any other code.
const APPROVE_CSRF_CONTEXT = 'daemon-approve'

// HMAC-SHA256(secret, "daemon-approve:<jti>:<code>") as base64url. Unguessable without the secret,
// and deterministic so GET-embed and POST-verify produce the same value for the same (session, code).
export async function approveCsrfToken(env: Env, jti: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JWT_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const msg = new TextEncoder().encode(`${APPROVE_CSRF_CONTEXT}:${jti}:${code}`)
  const sig = await crypto.subtle.sign('HMAC', key, msg)
  const bytes = new Uint8Array(sig)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Constant-time string compare so a wrong CSRF token can't be probed byte-by-byte via timing. Both
// inputs are fixed-length base64url HMACs on the happy path, but we still length-guard + compare all
// bytes of the longer to avoid early-exit leakage.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

// The daemon posts JSON; the browser approve <form> posts urlencoded. Accept either and pull out the
// named fields we care about, so one endpoint serves both without a second route.
async function readFields(
  c: { req: { raw: Request } },
  names: readonly string[]
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const n of names) out[n] = null
  const ct = c.req.raw.headers.get('content-type') ?? ''
  try {
    if (ct.includes('application/json')) {
      const body = await c.req.raw.json()
      if (typeof body === 'object' && body !== null) {
        const rec = body as Record<string, unknown>
        for (const n of names) {
          const v = rec[n]
          if (typeof v === 'string' && v.length > 0) out[n] = v
        }
      }
    } else {
      const form = await c.req.raw.formData()
      for (const n of names) {
        const v = form.get(n)
        if (typeof v === 'string' && v.length > 0) out[n] = v
      }
    }
  } catch {
    // Malformed body — leave everything null.
  }
  return out
}

// Sanitize a user-supplied machine name: trim, strip ASCII control chars, cap at 64 chars.
// Falls back to 'New machine' when absent/empty after sanitization.
function sanitizeName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return defaultDaemonName()
  const clean = Array.from(raw.trim())
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
    .join('')
  const capped = clean.slice(0, 64)
  return capped.length > 0 ? capped : defaultDaemonName()
}

// /token needs the code + an optional display name.
async function readTokenBody(c: {
  req: { raw: Request }
}): Promise<{ code: string | null; name: string | null }> {
  const fields = await readFields(c, ['code', 'name'])
  return { code: fields.code ?? null, name: fields.name ?? null }
}

// /approve needs the code AND the CSRF token (HARDEN §5).
async function readApproveForm(c: {
  req: { raw: Request }
}): Promise<{ code: string | null; csrf: string | null }> {
  const f = await readFields(c, ['code', 'csrf'])
  return { code: f.code ?? null, csrf: f.csrf ?? null }
}

export const daemonRoutes = new Hono<{ Bindings: Env }>()

// Step 1 — daemon asks for a one-time code. No auth: the code is useless until a human approves it.
daemonRoutes.post('/code', async (c) => {
  const now = Date.now()
  const code = randomSecret('hc_')
  await createDaemonCode(c.env.DB, { code, createdAt: now, expiresAt: now + DAEMON_CODE_TTL_MS })
  return c.json({ code, expiresAt: now + DAEMON_CODE_TTL_MS, pollIntervalMs: DAEMON_CODE_POLL_MS })
})

// Step 2a — the approval page the human opens in their (logged-in) browser. Requires a session;
// shows the code so they can match it to what the daemon printed before confirming, and embeds a
// session+code-bound CSRF token (HARDEN §5) that POST /approve will require. Served with
// frame-busting headers so it can't be clickjacked.
daemonRoutes.get('/approve', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  const code = c.req.query('code') ?? ''
  if (session === null) {
    // Not logged in: bounce to the login chooser carrying a return path back to THIS approve URL (code
    // preserved), so opening the `hive remote login` link before signing in lands on the confirm page
    // after OAuth instead of a dead-end. /daemon/approve is allowlisted in validateRedirect and the
    // code is base64url, so the round-trip is safe. No CSRF token is minted for an unauthenticated
    // viewer (it's bound to the session jti).
    const back = `/daemon/approve?code=${encodeURIComponent(code)}`
    return c.redirect(`/?redirect=${encodeURIComponent(back)}`, 302)
  }
  const csrf = await approveCsrfToken(c.env, session.jti, code)
  return c.html(approvePage(code, csrf), 200, HTML_SECURITY_HEADERS)
})

// Step 2b — the human confirms. Binds the code to THEIR account. A daemon (no session) gets 401
// here, which is the self-approval defense. The CSRF token must match HMAC(secret, jti+code) for the
// CURRENT session (HARDEN §5) — missing/wrong/cross-session/cross-code => 403, no DB write.
// Already-approved/expired codes (incl. a replayed valid token) get 409.
daemonRoutes.post('/approve', async (c) => {
  const session = await sessionFromRequest(c.env, c.req.raw)
  if (session === null) return c.json({ error: 'login_required' }, 401)

  const { code, csrf } = await readApproveForm(c)
  if (code === null) return c.json({ error: 'missing_code' }, 400)

  // CSRF gate BEFORE any state change: recompute the expected token for this session+code and
  // constant-time compare. A blind cross-site/same-origin POST can't produce it, and a token minted
  // under another session/code won't match.
  const expected = await approveCsrfToken(c.env, session.jti, code)
  if (csrf === null || !timingSafeEqual(csrf, expected)) {
    return c.json({ error: 'csrf_failed' }, 403)
  }

  const ok = await approveDaemonCode(c.env.DB, { code, userId: session.userId, now: Date.now() })
  if (!ok) {
    // Unknown / expired / already-approved / already-consumed — don't say which (no oracle).
    return c.json({ error: 'code_not_approvable' }, 409)
  }
  return c.json({ approved: true })
})

// Step 3 — the daemon exchanges the (now approved) code for its long-term token, exactly once.
// consumeApprovedDaemonCode atomically checks "approved && unexpired && unconsumed" and stamps
// consumed_at, so a replay finds nothing. On success we create the daemon row (token minted here,
// hash stored) and back-link it onto the code for the audit trail.
// G3: an optional 'name' field in the request body is sanitized and used as the machine display name.
daemonRoutes.post('/token', async (c) => {
  const { code, name: rawName } = await readTokenBody(c)
  if (code === null) return c.json({ error: 'missing_code' }, 400)

  const now = Date.now()
  const consumed = await consumeApprovedDaemonCode(c.env.DB, { code, now })
  if (consumed === null) {
    // Not yet approved, expired, or already exchanged — the daemon should keep polling or restart.
    return c.json({ error: 'not_approved' }, 401)
  }

  const daemonId = crypto.randomUUID()
  const daemonToken = randomSecret('hd_')
  await createDaemon(c.env.DB, {
    id: daemonId,
    userId: consumed.userId,
    name: sanitizeName(rawName),
    daemonToken,
    now,
  })
  await linkDaemonCode(c.env.DB, code, daemonId)

  // The ONLY time the raw token leaves the gateway. The daemon stores it; we keep only its hash.
  return c.json({ daemonId, daemonToken })
})

// Minimal self-contained confirm page. Real styling/bundle comes from the login-page sub-task; this
// keeps the flow testable end-to-end without depending on it. The code (and CSRF token) are reflected
// only into attribute values and HTML-escaped, so a crafted ?code= can't inject markup. The hidden
// csrf field is what POST /approve requires (HARDEN §5).
function approvePage(code: string, csrf: string): string {
  const safeCode = escapeHtml(code)
  const safeCsrf = escapeHtml(csrf)
  const body = `<h1>Link this machine?</h1>
  <p class="sub">A device asked to connect to your Hive account.</p>
  <div class="sect__h">Code from your computer</div>
  <code class="codeblock">${safeCode}</code>
  <div class="note">Approve only if this matches the code shown by <code class="code">hive remote login</code> on your computer.</div>
  <form method="POST" action="/daemon/approve">
    <input type="hidden" name="code" value="${safeCode}">
    <input type="hidden" name="csrf" value="${safeCsrf}">
    <button type="submit" class="btn btn--primary">Approve this machine</button>
  </form>`
  return renderShell('Approve machine · Hive', body)
}
