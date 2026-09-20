// GitHub OAuth (authorization-code + PKCE). Accounts key on the immutable GitHub user id
// (provider_sub) — never on email. The flow-state cookie is the CSRF binding (see oauth-common).
//
// authorize:  GET /auth/github          -> 302 to GitHub, sets hive_oauth_gh flow cookie
// callback:    GET /auth/github/callback -> verifies state, exchanges code (PKCE), fetches identity,
//                                           upserts the user, mints a FRESH browser session, 302 home.
//
// Every callback step is a gate; any failure is a uniform 4xx with the flow cookie cleared
// (single-use). No provider body/token/secret is ever echoed (invariant #8).

import type { Context } from 'hono'
import type { Env } from './env.js'
import {
  FLOW_TTL_MS,
  flowClearCookie,
  flowSetCookie,
  GH_FLOW_COOKIE,
  type NormalizedIdentity,
  OAuthError,
  randB64url,
  readFlowCookie,
  sha256Base64url,
  signFlowState,
  upsertIdentity,
  validateRedirect,
  verifyFlowState,
} from './oauth-common.js'
import { BROWSER_SESSION_TTL_MS, mintSession, sessionSetCookie } from './sessions.js'

const CALLBACK_PATH = '/auth/github/callback'
const GH_SCOPE = 'read:user user:email'

type Ctx = Context<{ Bindings: Env }>

// A 4xx that ALWAYS clears the flow cookie (single-use, even on failure) and carries no detail.
function fail(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'content-type': 'application/json',
      'Set-Cookie': flowClearCookie(GH_FLOW_COOKIE, CALLBACK_PATH),
    },
  })
}

export async function ghAuthorize(c: Ctx): Promise<Response> {
  const env = c.env
  const redirect = validateRedirect(env, c.req.query('redirect') ?? null)
  const state = randB64url(32)
  const codeVerifier = randB64url(32)
  const challenge = await sha256Base64url(codeVerifier)

  const flow = await signFlowState(env, {
    p: 'github',
    state,
    codeVerifier,
    redirect,
    exp: Date.now() + FLOW_TTL_MS,
  })

  const authorizeUrl = new URL(`${env.GITHUB_OAUTH_BASE}/authorize`)
  authorizeUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  authorizeUrl.searchParams.set('redirect_uri', `${env.GATEWAY_ORIGIN}${CALLBACK_PATH}`)
  authorizeUrl.searchParams.set('scope', GH_SCOPE)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('allow_signup', 'true')

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      'Set-Cookie': flowSetCookie(GH_FLOW_COOKIE, flow, CALLBACK_PATH),
    },
  })
}

export async function ghCallback(c: Ctx): Promise<Response> {
  const env = c.env
  const req = c.req.raw

  // 1. read inputs + flow cookie
  const code = c.req.query('code')
  const queryState = c.req.query('state')
  const providerError = c.req.query('error')
  const flowCookie = readFlowCookie(req, GH_FLOW_COOKIE)

  // 2. no cookie / bad-or-expired cookie => CSRF binding absent
  if (flowCookie === null) return fail('invalid_state', 400)
  const flow = await verifyFlowState(env, flowCookie)
  if (flow === null || flow.p !== 'github') return fail('invalid_state', 400)

  // 3. user denied / state mismatch / missing code
  if (providerError !== undefined) return fail('access_denied', 400)
  if (!queryState || queryState !== flow.state) return fail('state_mismatch', 400)
  if (!code) return fail('missing_code', 400)

  try {
    // 4. exchange code (PKCE verifier) for an access token
    const { accessToken } = await ghExchangeCode(env, code, flow.codeVerifier)
    // 5. fetch the GitHub identity
    const identity = await ghFetchIdentity(env, accessToken)
    // 6. first login == signup, keyed on provider_sub
    const { userId } = await upsertIdentity(env, identity)
    // 7. fresh browser session (session-fixation defense: ignore any pre-existing cookie)
    const { token } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    // 8. 302 to the re-validated redirect, set session + clear flow cookie
    const redirect = validateRedirect(env, flow.redirect)
    return new Response(null, {
      status: 302,
      headers: new Headers([
        ['Location', redirect],
        ['Set-Cookie', sessionSetCookie(token, BROWSER_SESSION_TTL_MS)],
        ['Set-Cookie', flowClearCookie(GH_FLOW_COOKIE, CALLBACK_PATH)],
      ]),
    })
  } catch (err) {
    const status = err instanceof OAuthError ? err.status : 400
    const codeStr = err instanceof OAuthError ? err.code : 'oauth_failed'
    return fail(codeStr, status)
  }
}

// Exchange the authorization code (with the PKCE verifier) for an access token. GitHub may return
// HTTP 200 with an {error} body — that's a failure. We never surface the body.
export async function ghExchangeCode(
  env: Env,
  code: string,
  codeVerifier: string
): Promise<{ accessToken: string }> {
  const res = await fetch(`${env.GITHUB_OAUTH_BASE}/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.GATEWAY_ORIGIN}${CALLBACK_PATH}`,
      code_verifier: codeVerifier,
    }),
  })
  if (!res.ok) throw new OAuthError('oauth_exchange_failed', 400)
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown
    error?: unknown
  } | null
  const token = body?.access_token
  if (typeof token !== 'string' || token.length === 0)
    throw new OAuthError('oauth_exchange_failed', 400)
  return { accessToken: token }
}

// Fetch the GitHub user + emails. User-Agent is required by GitHub (missing UA => 403). Picks the
// first primary+verified email as the informational address; no verified-primary => we still create
// the account (provider_sub is the identity; email is never a join key) but store null.
export async function ghFetchIdentity(env: Env, accessToken: string): Promise<NormalizedIdentity> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'hive-gateway',
  }
  const userRes = await fetch(`${env.GITHUB_API_BASE}/user`, { headers })
  if (!userRes.ok) throw new OAuthError('identity_failed', 400)
  const user = (await userRes.json().catch(() => null)) as {
    id?: unknown
    login?: unknown
    name?: unknown
  } | null
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) {
    throw new OAuthError('identity_failed', 400)
  }
  const providerSub = String(user.id)
  const login = typeof user.login === 'string' ? user.login : null
  const name = typeof user.name === 'string' ? user.name : null

  let email: string | null = null
  const emailsRes = await fetch(`${env.GITHUB_API_BASE}/user/emails`, { headers })
  if (emailsRes.ok) {
    const emails = (await emailsRes.json().catch(() => null)) as Array<{
      email?: unknown
      primary?: unknown
      verified?: unknown
    }> | null
    if (Array.isArray(emails)) {
      const hit = emails.find(
        (e) => e.primary === true && e.verified === true && typeof e.email === 'string'
      )
      if (hit && typeof hit.email === 'string') email = hit.email
    }
  }

  return { provider: 'github', providerSub, email, displayName: name ?? login }
}
