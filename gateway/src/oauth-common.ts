// Shared OAuth machinery for both providers: flow-state (the CSRF binding), PKCE primitives, the
// open-redirect allowlist, identity upsert, and a uniform failure surface.
//
// The OAuth flow is STATELESS on the server — there is no row written at authorize time. The whole
// CSRF binding is a short-lived, signed, HttpOnly cookie carrying {state, codeVerifier, nonce?,
// redirect}. The callback re-reads it, checks `flow.state === query.state`, then clears it
// (single-use). The cookie is signed with JWT_SIGNING_SECRET (the SAME secret as the session JWT —
// one secret to rotate) but pinned to a DIFFERENT `purpose` so a flow-state token can never be
// replayed as a session and vice versa (HARDEN §1.1/§4.1; session side pins SESSION_TOKEN_PURPOSE).
//
// HARDEN §4.1 (login-CSRF / session fixation): the callback ALWAYS mints a fresh session jti and
// ignores any pre-existing session cookie, so an attacker-initiated flow handed to a victim can't
// silently fold the victim into the attacker's account beyond what the freshly-minted cookie says —
// and the flow cookie is host-only (no Domain), Secure, HttpOnly, SameSite=Lax, Path-scoped to the
// callback. The flow cookie name is per-provider; concurrent same-provider tabs are tolerated
// because state is re-verified against whichever cookie the browser sends on the matching callback.

import { jwtVerify, SignJWT } from 'jose'
import { upsertUser } from './db.js'
import type { Env } from './env.js'

export interface NormalizedIdentity {
  provider: 'github' | 'google'
  providerSub: string // gh: numeric user id as string; google: id_token 'sub'
  email: string | null // primary+verified (gh) / email_verified (google); informational, never a join key
  displayName: string | null
}

// Carried in the signed flow cookie. `exp` is epoch ms; the JWT also carries a jose `exp` so a
// tampered/expired token fails signature/exp verification before we ever read these fields.
export interface OAuthFlowState {
  p: 'github' | 'google'
  state: string // 32 random bytes base64url — the CSRF token echoed in the query
  codeVerifier: string // PKCE verifier, 32 random bytes base64url
  nonce?: string // Google only
  redirect: string // already allowlist-validated path
  exp: number // epoch ms; informational mirror of the JWT exp
}

export const GH_FLOW_COOKIE = 'hive_oauth_gh'
export const GOOGLE_FLOW_COOKIE = 'hive_oauth_g'
export const FLOW_TTL_MS = 600_000 // 10 min — enough to log in at the provider, short enough to limit replay

// Token-type pin for the flow-state JWT. Disjoint from sessions' SESSION_TOKEN_PURPOSE so the two
// token sets can never be confused even though they share JWT_SIGNING_SECRET.
const FLOW_PURPOSE = 'oauth-flow'
const PURPOSE_CLAIM = 'purpose'
const FLOW_ALG = 'HS256'

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.JWT_SIGNING_SECRET)
}

// base64url of `byteLen` CSPRNG bytes — same alphabet as the session/daemon helpers (no +, /, =).
export function randB64url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// PKCE S256 challenge: base64url(SHA-256(verifier)). 32-byte digest => 43-char base64url, no padding.
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Sign the flow state into a compact HS256 JWT. The state/verifier/nonce/redirect ride as custom
// claims; jose enforces exp on verify.
export async function signFlowState(env: Env, s: OAuthFlowState): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    [PURPOSE_CLAIM]: FLOW_PURPOSE,
    p: s.p,
    state: s.state,
    cv: s.codeVerifier,
    redirect: s.redirect,
  }
  if (s.nonce !== undefined) payload.nonce = s.nonce
  return new SignJWT(payload)
    .setProtectedHeader({ alg: FLOW_ALG, typ: 'JWT' })
    .setIssuer(env.GATEWAY_ORIGIN)
    .setAudience(env.GATEWAY_ORIGIN)
    .setIssuedAt(now)
    .setExpirationTime(Math.floor(s.exp / 1000))
    .sign(secretKey(env))
}

// Verify the flow cookie: pin HS256 (no none/confusion), iss+aud=GATEWAY_ORIGIN, exp (jose), and the
// flow purpose. Returns null on ANY failure (bad sig / expired / wrong purpose / malformed shape) so
// a session JWT presented as a flow cookie is rejected, and there is no oracle.
export async function verifyFlowState(env: Env, jwt: string): Promise<OAuthFlowState | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const result = await jwtVerify(jwt, secretKey(env), {
      algorithms: [FLOW_ALG],
      issuer: env.GATEWAY_ORIGIN,
      audience: env.GATEWAY_ORIGIN,
      requiredClaims: ['exp', PURPOSE_CLAIM],
    })
    payload = result.payload
  } catch {
    return null
  }
  if (payload[PURPOSE_CLAIM] !== FLOW_PURPOSE) return null

  const rec = payload as Record<string, unknown>
  const p = rec.p
  const state = rec.state
  const cv = rec.cv
  const redirect = rec.redirect
  if (p !== 'github' && p !== 'google') return null
  if (typeof state !== 'string' || typeof cv !== 'string' || typeof redirect !== 'string') {
    return null
  }
  const nonce = typeof rec.nonce === 'string' ? rec.nonce : undefined
  const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : 0

  const out: OAuthFlowState = { p, state, codeVerifier: cv, redirect, exp: expMs }
  if (nonce !== undefined) out.nonce = nonce
  return out
}

// Host-only (no Domain), Secure, HttpOnly, SameSite=Lax, Path-scoped to the callback so it only
// rides the one redirect it's for. Lax lets it survive the top-level redirect back from the provider.
export function flowSetCookie(name: string, value: string, callbackPath: string): string {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${callbackPath}; Max-Age=${FLOW_TTL_MS / 1000}`
}

export function flowClearCookie(name: string, callbackPath: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${callbackPath}; Max-Age=0`
}

// Extract a named flow cookie from the request. Defensive parse: malformed header => null.
export function readFlowCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim()
      return v.length > 0 ? v : null
    }
  }
  return null
}

// Fixed allowlist of post-login destinations (open-redirect defense). Anything off-list collapses to '/'.
export const ALLOWED_REDIRECT_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/machines',
  '/pair',
  '/connect',
  '/devices',
  // The mobile app shell (bundles.ts GET /app). The phone's connect flow bounces through OAuth on a
  // 401 with redirect=window.location.pathname (= /app); without this it collapses to '/' and the
  // user lands on the server page instead of back in the app, stranding the pairing flow.
  '/app',
  // The daemon-binding approval page. A human who opens the `hive remote login` link before signing in
  // is bounced through OAuth and must land back HERE (with ?code= preserved) instead of a dead-end —
  // see daemon.ts GET /approve. validateRedirect keeps pathname+search, so the code survives.
  '/daemon/approve',
])

// Returns a SAFE same-origin path. Rejects (=> '/') anything that isn't a plain absolute path on our
// own origin and in the allowlist. Catches naive echo, protocol-relative (//evil), backslash tricks
// (/\evil), and look-alike hosts (app.hivehq.dev.evil.com).
export function validateRedirect(env: Env, raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/' // must be a root-relative path
  if (raw.startsWith('//')) return '/' // protocol-relative => off-origin
  if (raw.includes('\\')) return '/' // backslash normalization tricks
  let u: URL
  try {
    u = new URL(raw, env.GATEWAY_ORIGIN)
  } catch {
    return '/'
  }
  if (u.origin !== new URL(env.GATEWAY_ORIGIN).origin) return '/'
  if (!ALLOWED_REDIRECT_PATHS.has(u.pathname)) return '/'
  return u.pathname + u.search
}

// First login == signup. Idempotent on (provider, provider_sub) — NEVER keyed on email. Returns the
// canonical user id.
export async function upsertIdentity(
  env: Env,
  id: NormalizedIdentity
): Promise<{ userId: string }> {
  const row = await upsertUser(env.DB, {
    provider: id.provider,
    providerSub: id.providerSub,
    email: id.email,
    now: Date.now(),
    newId: crypto.randomUUID(),
  })
  return { userId: row.id }
}

// Uniform OAuth failure. NEVER echoes provider bodies, tokens, secrets, or stack traces — just a
// short machine code + status. No oracle distinguishing which step failed beyond the code we choose.
export class OAuthError extends Error {
  constructor(
    public code: string,
    public status: number
  ) {
    super(code)
    this.name = 'OAuthError'
  }
}
