// JWT session layer. Our own session token is an HS256 JWT signed with JWT_SIGNING_SECRET. This is
// the ONLY place that mints/verifies it, so the security invariants (alg pin, exp, revocation,
// cookie hardening) live in one auditable spot.
//
// Verification pins alg to HS256 (jose rejects alg=none unconditionally and the `algorithms` array
// rejects alg-confusion / downgrade), pins iss + aud to GATEWAY_ORIGIN, lets jose enforce exp, and
// THEN checks the revocation deny-list by jti. Any failure returns null — never an error to the
// caller, never a reason leak (no oracle distinguishing "expired" vs "bad sig" vs "revoked").

import { jwtVerify, SignJWT } from 'jose'
import { createSession, isRevoked } from './db.js'
import type { Env } from './env.js'

export const SESSION_COOKIE_NAME = 'hive_gw_session'

// Browser-login session: lives long enough to approve a daemon binding / pairing without re-login,
// short enough that a stolen laptop cookie ages out. Phone sessions are longer-lived (silent
// re-establish on app open) but bounded by device revocation.
export const BROWSER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const PHONE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const ALG = 'HS256'

// Token-type discriminator (HARDEN §1.1/§4.1). The session JWT and the OAuth flow-state JWT are both
// HS256 signed with the SAME JWT_SIGNING_SECRET (one secret to rotate). To stop a flow-state token
// from being replayed where a session is expected (token-type confusion), mintSession stamps this
// exact `purpose` claim and verifySession REQUIRES it. The flow-state signer MUST pin a different
// value (e.g. 'oauth-flow') so the two token sets are disjoint by construction, not just by shape.
export const SESSION_TOKEN_PURPOSE = 'session'
const PURPOSE_CLAIM = 'purpose'

// Resolved session identity. deviceId is null for the desktop browser-login session, set for a
// paired phone. We expose only what the rest of the worker needs — never the raw JWT payload.
export interface SessionClaims {
  userId: string
  jti: string
  deviceId: string | null
  expiresAtMs: number
}

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.JWT_SIGNING_SECRET)
}

export interface MintInput {
  userId: string
  deviceId: string | null
  ttlMs: number
}

export interface MintResult {
  token: string
  jti: string
  expiresAtMs: number
}

// Sign a session JWT and record the jti so we can revoke it before exp. The id/clock are derived
// here (single mint point); callers don't inject them. `did` (device id) is added only for phone
// sessions so the desktop session can't be mistaken for a paired device.
export async function mintSession(env: Env, input: MintInput): Promise<MintResult> {
  const now = Date.now()
  const expiresAtMs = now + input.ttlMs
  const jti = crypto.randomUUID()

  // Custom claims go in the constructor payload (jose has no setCustomClaim). `purpose` pins the
  // token type (see SESSION_TOKEN_PURPOSE); `did` is present only for phone sessions so the desktop
  // login session can never be read as a paired device.
  const extra: Record<string, unknown> = { [PURPOSE_CLAIM]: SESSION_TOKEN_PURPOSE }
  if (input.deviceId !== null) extra.did = input.deviceId

  const token = await new SignJWT(extra)
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuer(env.GATEWAY_ORIGIN)
    .setAudience(env.GATEWAY_ORIGIN)
    .setJti(jti)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(secretKey(env))

  await createSession(env.DB, {
    jti,
    userId: input.userId,
    deviceId: input.deviceId,
    createdAt: now,
    expiresAt: expiresAtMs,
  })

  return { token, jti, expiresAtMs }
}

// Verify signature + alg + iss + aud + exp via jose, then the revocation deny-list. Returns the
// resolved claims or null. Never throws to the caller.
export async function verifySession(env: Env, token: string): Promise<SessionClaims | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const result = await jwtVerify(token, secretKey(env), {
      algorithms: [ALG], // pins HS256: blocks alg=none + alg confusion/downgrade
      issuer: env.GATEWAY_ORIGIN,
      audience: env.GATEWAY_ORIGIN,
      requiredClaims: ['sub', 'jti', 'exp', PURPOSE_CLAIM],
    })
    payload = result.payload
  } catch {
    return null // bad sig / wrong alg / expired / missing claim — all collapse to "no session"
  }

  // Token-type pin: requiredClaims only asserts `purpose` is present, not its value. Reject anything
  // that isn't exactly a session token (e.g. a flow-state JWT signed with the same secret). jose
  // can't compare custom-claim values, so we do it here.
  if (payload[PURPOSE_CLAIM] !== SESSION_TOKEN_PURPOSE) return null

  const jti = payload.jti
  const userId = payload.sub
  if (typeof jti !== 'string' || typeof userId !== 'string') return null

  // Revoked-before-exp check (logout, device revoke, sign-out-everywhere).
  if (await isRevoked(env.DB, 'session', jti)) return null

  const didClaim = (payload as Record<string, unknown>).did
  const deviceId = typeof didClaim === 'string' ? didClaim : null
  const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : 0

  return { userId, jti, deviceId, expiresAtMs }
}

// ---------------------------------------------------------------------------
// Cookie helpers — HttpOnly + Secure + SameSite=Lax. Lax (not Strict) so the cookie still rides
// the top-level redirect back from the OAuth provider; the token itself is unguessable + signed.
// ---------------------------------------------------------------------------

const COOKIE_BASE = `Path=/; HttpOnly; Secure; SameSite=Lax`

export function sessionSetCookie(token: string, ttlMs: number): string {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000))
  return `${SESSION_COOKIE_NAME}=${token}; ${COOKIE_BASE}; Max-Age=${maxAge}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${COOKIE_BASE}; Max-Age=0`
}

// Extract our session token from a request's Cookie header, ignoring other cookies. Returns null if
// absent. Parses defensively — a malformed Cookie header just means "no session".
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim()
      return value.length > 0 ? value : null
    }
  }
  return null
}

// Convenience for route guards: resolve the caller's logged-in session from the request, or null.
export async function sessionFromRequest(env: Env, req: Request): Promise<SessionClaims | null> {
  const token = readSessionCookie(req)
  if (token === null) return null
  return verifySession(env, token)
}
