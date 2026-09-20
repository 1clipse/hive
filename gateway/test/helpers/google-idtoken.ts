// Mint Google-style id_tokens for OAuth tests, plus a JWKS the gateway can verify against WITHOUT
// real network. We generate an RS256 keypair once per call, export the public key as a JWK (with a
// kid), and build a local key resolver (createLocalJWKSet) the test hands to googleVerifyIdToken via
// its `getKey` seam. Forge helpers also emit tokens the product MUST reject (alg:none, RS↔HS
// confusion, unknown kid) — those are the point of the OIDC suite.

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose'

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)))
}

export interface GoogleTokenClaims {
  iss: string
  aud: string
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  nonce?: string
  iat?: number
  exp?: number
}

export interface GoogleSigner {
  // A local key resolver over the public JWK — hand this to googleVerifyIdToken(env, token, nonce, getKey).
  getKey: JWTVerifyGetKey
  // The public JWK as Google would publish at GOOGLE_JWKS_URL, for tests that mock the JWKS endpoint.
  jwks: { keys: JWK[] }
  // Mint a correctly RS256-signed id_token with the given claims (kid matches the published JWK).
  mint(claims: GoogleTokenClaims): Promise<string>
  // The kid stamped into tokens this signer mints.
  kid: string
  // The public JWK (single key) for reuse (e.g. building an HMAC-confusion probe off the modulus).
  publicJwk: JWK
}

// One real RS256 keypair + a kid. `mint` produces tokens the published JWKS can verify.
export async function makeGoogleSigner(): Promise<GoogleSigner> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const kid = `test-kid-${crypto.randomUUID()}`
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = kid
  publicJwk.alg = 'RS256'
  publicJwk.use = 'sig'
  const jwks = { keys: [publicJwk] }
  const getKey = createLocalJWKSet(jwks)

  async function mint(claims: GoogleTokenClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const { iat, exp, ...rest } = claims
    return new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuedAt(iat ?? now)
      .setExpirationTime(exp ?? now + 3600)
      .sign(privateKey)
  }

  return { getKey, jwks, mint, kid, publicJwk }
}

// An id_token with header alg:none and an empty signature. Must be rejected by the alg pin.
export function forgeNoneAlgIdToken(claims: GoogleTokenClaims): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlJson({ alg: 'none', kid: 'whatever', typ: 'JWT' })
  const payload = b64urlJson({ iat: now, exp: now + 3600, ...claims })
  return `${header}.${payload}.`
}

// RS↔HS confusion probe: claim alg HS256 and HMAC-sign using the RSA PUBLIC modulus (n) as the key.
// A verifier that fetched the RSA public key but didn't pin algorithms:['RS256'] would treat the
// public key bytes as an HMAC secret and accept this. Pinning RS256 must reject it.
export async function forgeHmacWithPublicModulus(
  claims: GoogleTokenClaims,
  publicJwk: JWK,
  kid: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlJson({ alg: 'HS256', kid, typ: 'JWT' })
  const payload = b64urlJson({ iat: now, exp: now + 3600, ...claims })
  const signingInput = `${header}.${payload}`
  // Use the base64url-decoded modulus bytes as the HMAC key (the canonical confusion attack).
  const nB64url = (publicJwk.n ?? '') as string
  const nB64 = nB64url.replace(/-/g, '+').replace(/_/g, '/')
  const binStr = atob(nB64.padEnd(nB64.length + ((4 - (nB64.length % 4)) % 4), '='))
  const keyBytes = new Uint8Array(binStr.length)
  for (let i = 0; i < binStr.length; i++) keyBytes[i] = binStr.charCodeAt(i)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signingInput)))
  return `${signingInput}.${b64url(sig)}`
}
