import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { createDevice, upsertUser } from '../src/db.js'
import {
  BROWSER_SESSION_TTL_MS,
  clearSessionCookie,
  mintSession,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_PURPOSE,
  sessionSetCookie,
  verifySession,
} from '../src/sessions.js'
import {
  type ForgeClaims,
  forgeNoneAlg,
  forgeSignedWithRealSecret,
  forgeValidHs384,
  forgeWrongSecret,
} from './helpers/jwt.js'

// A real user row to satisfy the sessions.user_id FK. Unique per test to avoid cross-test bleed.
async function makeUser(sub: string): Promise<string> {
  const id = crypto.randomUUID()
  const row = await upsertUser(env.DB, {
    provider: 'github',
    providerSub: sub,
    email: null,
    now: Date.now(),
    newId: id,
  })
  return row.id
}

function baseClaims(userId: string, overrides: Partial<ForgeClaims> = {}): ForgeClaims {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: userId,
    jti: crypto.randomUUID(),
    iss: env.GATEWAY_ORIGIN,
    aud: env.GATEWAY_ORIGIN,
    iat: now,
    exp: now + 3600,
    ...overrides,
  }
}

// Decode a compact JWT payload without verifying — used only to assert what mintSession PUT in the
// token (e.g. the pinned `purpose` claim), not to make a trust decision.
function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? ''
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
  const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))
  return JSON.parse(json) as Record<string, unknown>
}

describe('mintSession / verifySession roundtrip', () => {
  test('a freshly minted session verifies and returns its claims', async () => {
    const userId = await makeUser('rt-1')
    const { token, jti } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })

    const claims = await verifySession(env, token)
    expect(claims).not.toBeNull()
    expect(claims?.userId).toBe(userId)
    expect(claims?.jti).toBe(jti)
    expect(claims?.deviceId).toBeNull()
  })

  test('a phone session carries its deviceId claim', async () => {
    const userId = await makeUser('rt-2')
    // sessions.device_id FKs to devices, so a paired device row must exist first (matches reality:
    // a phone session is only minted after the device is approved + created).
    const deviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: deviceId,
      userId,
      name: 'Pixel 9',
      devicePubkey: 'base64url-pubkey',
      now: Date.now(),
    })
    const { token } = await mintSession(env, { userId, deviceId, ttlMs: BROWSER_SESSION_TTL_MS })
    const claims = await verifySession(env, token)
    expect(claims?.deviceId).toBe(deviceId)
  })

  test('mintSession persists a sessions row so it can be revoked before exp', async () => {
    const userId = await makeUser('rt-3')
    const { jti } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    const row = await env.DB.prepare('SELECT * FROM sessions WHERE jti = ?1').bind(jti).first()
    expect(row).not.toBeNull()
    expect(row?.user_id).toBe(userId)
  })
})

describe('algorithm pinning (alg confusion / none)', () => {
  test('rejects a token with alg=none', async () => {
    const userId = await makeUser('alg-none')
    // Otherwise-perfect token (correct claims incl. purpose) — only alg=none is wrong, so this proves
    // alg=none is refused on its own, not shadowed by a missing-claim rejection.
    const token = forgeNoneAlg(baseClaims(userId, { purpose: SESSION_TOKEN_PURPOSE }))
    expect(await verifySession(env, token)).toBeNull()
  })

  test('rejects a VALID HS384 token signed with the same secret (proves the HS256 pin, not just sig)', async () => {
    const userId = await makeUser('alg-downgrade')
    // Fully-valid session token EXCEPT the alg: same secret, correct iss/aud/exp AND the required
    // `purpose` claim — so the ONLY thing that can reject it is the HS256 alg pin. (Without purpose
    // it would be rejected on the missing-required-claim check and pass even if the pin were removed.)
    const token = await forgeValidHs384(
      baseClaims(userId, { purpose: SESSION_TOKEN_PURPOSE }),
      env.JWT_SIGNING_SECRET
    )
    expect(await verifySession(env, token)).toBeNull()
  })
})

describe('token-type confusion (HARDEN §1.1/§4.1 — shared JWT_SIGNING_SECRET)', () => {
  // The session JWT and the OAuth flow-state JWT are both HS256 signed with the SAME
  // JWT_SIGNING_SECRET. Without a pinned, disjoint type marker a flow-state token (valid sig + exp +
  // iss + aud) could be replayed where a session is expected. mintSession stamps a fixed `purpose`
  // claim; verifySession REQUIRES that exact value.

  test('mintSession stamps the pinned session purpose claim', async () => {
    const userId = await makeUser('purpose-stamp')
    const { token } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    expect(decodePayload(token).purpose).toBe(SESSION_TOKEN_PURPOSE)
    // and the stamped value is a real, non-empty discriminator (not '' / undefined sneaking through)
    expect(typeof SESSION_TOKEN_PURPOSE).toBe('string')
    expect(SESSION_TOKEN_PURPOSE.length).toBeGreaterThan(0)
  })

  test('rejects a flow-state-shaped token (valid sig/iss/aud/exp but wrong purpose) presented as a session', async () => {
    const userId = await makeUser('flow-as-session')
    // Worst case: a flow-state token that ALSO carries sub+jti+exp (so requiredClaims alone would
    // pass) but whose purpose is the OAuth-flow discriminator, not 'session'. Signed with the real
    // secret, correct iss/aud — only the purpose differs. Must be rejected purely by the purpose pin.
    const token = await forgeSignedWithRealSecret(
      baseClaims(userId, { purpose: 'oauth-flow' }),
      env.JWT_SIGNING_SECRET
    )
    expect(await verifySession(env, token)).toBeNull()
  })

  test('rejects a token with no purpose claim at all', async () => {
    const userId = await makeUser('no-purpose')
    const claims = baseClaims(userId)
    delete (claims as Record<string, unknown>).purpose
    const token = await forgeSignedWithRealSecret(claims, env.JWT_SIGNING_SECRET)
    expect(await verifySession(env, token)).toBeNull()
  })

  test('a genuine session token (purpose stamped by mintSession) still verifies — positive control', async () => {
    const userId = await makeUser('purpose-positive')
    const { token } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    expect(await verifySession(env, token)).not.toBeNull()
  })
})

describe('signature + claim checks', () => {
  test('rejects an HS256 token signed with the wrong secret', async () => {
    const userId = await makeUser('wrong-secret')
    const token = await forgeWrongSecret(baseClaims(userId), `${env.JWT_SIGNING_SECRET}-tampered`)
    expect(await verifySession(env, token)).toBeNull()
  })

  test('rejects an expired token even when correctly signed with the real secret', async () => {
    const userId = await makeUser('expired')
    const past = Math.floor(Date.now() / 1000) - 10
    const token = await forgeSignedWithRealSecret(
      baseClaims(userId, { iat: past - 3600, exp: past }),
      env.JWT_SIGNING_SECRET
    )
    expect(await verifySession(env, token)).toBeNull()
  })

  test('rejects a token with the wrong audience', async () => {
    const userId = await makeUser('wrong-aud')
    const token = await forgeSignedWithRealSecret(
      baseClaims(userId, { aud: 'https://evil.example' }),
      env.JWT_SIGNING_SECRET
    )
    expect(await verifySession(env, token)).toBeNull()
  })

  test('rejects a token with the wrong issuer', async () => {
    const userId = await makeUser('wrong-iss')
    const token = await forgeSignedWithRealSecret(
      baseClaims(userId, { iss: 'https://evil.example' }),
      env.JWT_SIGNING_SECRET
    )
    expect(await verifySession(env, token)).toBeNull()
  })
})

describe('revocation', () => {
  test('a revoked jti no longer verifies even though the signature + exp are valid', async () => {
    const userId = await makeUser('revoke-1')
    const { token, jti } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    // sanity: valid before revoke
    expect(await verifySession(env, token)).not.toBeNull()

    const { revokeSession } = await import('../src/db.js')
    const did = await revokeSession(env.DB, { jti, userId, now: Date.now(), reason: 'logout' })
    expect(did).toBe(true)

    expect(await verifySession(env, token)).toBeNull()
  })

  test('revoke is account-scoped: a different user cannot revoke my jti', async () => {
    const me = await makeUser('revoke-owner')
    const attacker = await makeUser('revoke-attacker')
    const { token, jti } = await mintSession(env, {
      userId: me,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })

    const { revokeSession } = await import('../src/db.js')
    const did = await revokeSession(env.DB, {
      jti,
      userId: attacker,
      now: Date.now(),
      reason: 'logout',
    })
    expect(did).toBe(false)
    // still valid — attacker's revoke was a no-op
    expect(await verifySession(env, token)).not.toBeNull()
  })
})

describe('cookie helpers', () => {
  let setCookie = ''
  beforeEach(async () => {
    const userId = await makeUser(`cookie-${crypto.randomUUID()}`)
    const { token } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    setCookie = sessionSetCookie(token, BROWSER_SESSION_TTL_MS)
  })

  test('Set-Cookie carries the hardened attributes', () => {
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Path=\//i)
    expect(setCookie).toMatch(/Max-Age=\d+/i)
  })

  test('clearSessionCookie expires the cookie (Max-Age=0)', () => {
    const cleared = clearSessionCookie()
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cleared).toMatch(/Max-Age=0/i)
    expect(cleared).toMatch(/HttpOnly/i)
  })

  test('readSessionCookie extracts the token from a Cookie header among others', () => {
    const req = new Request('https://app.hivehq.dev/x', {
      headers: { Cookie: `foo=bar; ${SESSION_COOKIE_NAME}=the-token-value; baz=qux` },
    })
    expect(readSessionCookie(req)).toBe('the-token-value')
  })

  test('readSessionCookie returns null when the cookie is absent', () => {
    const req = new Request('https://app.hivehq.dev/x', { headers: { Cookie: 'foo=bar' } })
    expect(readSessionCookie(req)).toBeNull()
  })
})
