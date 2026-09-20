// Adversarial JWT forging helpers. These build tokens the product MUST reject — alg=none,
// alg-confusion, wrong secret, tampered claims. If verifySession ever accepts one of these the
// security test fails, which is the whole point. We hand-roll the compact serialization so we can
// emit shapes a well-behaved signer (jose SignJWT) refuses to produce (e.g. "alg":"none").

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)))
}

async function hmac(
  secret: string,
  signingInput: string,
  hash: 'SHA-256' | 'SHA-384'
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))
  return new Uint8Array(sig)
}

function hmacSha256(secret: string, signingInput: string): Promise<Uint8Array> {
  return hmac(secret, signingInput, 'SHA-256')
}

export interface ForgeClaims {
  sub: string
  jti: string
  iss: string
  aud: string
  iat: number
  exp: number
  did?: string
  // Arbitrary extra claims so a forged token can carry a different `purpose` (token-type confusion
  // probe) or any other field a real signer would emit.
  [extra: string]: unknown
}

// A token with header "alg":"none" and an empty signature — the classic unsigned-JWT attack.
export function forgeNoneAlg(claims: ForgeClaims): string {
  const header = b64urlJson({ alg: 'none', typ: 'JWT' })
  const payload = b64urlJson(claims)
  return `${header}.${payload}.`
}

// HS256 token signed with the WRONG secret. Header is honest; only the key is wrong.
export async function forgeWrongSecret(claims: ForgeClaims, wrongSecret: string): Promise<string> {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const payload = b64urlJson(claims)
  const signingInput = `${header}.${payload}`
  const sig = await hmacSha256(wrongSecret, signingInput)
  return `${signingInput}.${b64url(sig)}`
}

// A VALID HS384 token, correctly signed with the same symmetric secret. This is the real
// alg-confusion / downgrade probe: jose given a symmetric key would happily verify HS384 if the
// `algorithms` pin were absent, so this token MUST be rejected purely by the HS256 pin — not by a
// signature mismatch. If verifySession ever accepts it, the pin regressed.
export async function forgeValidHs384(claims: ForgeClaims, secret: string): Promise<string> {
  const header = b64urlJson({ alg: 'HS384', typ: 'JWT' })
  const payload = b64urlJson(claims)
  const signingInput = `${header}.${payload}`
  const sig = await hmac(secret, signingInput, 'SHA-384')
  return `${signingInput}.${b64url(sig)}`
}

// A correctly HS256-signed token with whatever claims we pass (e.g. already-expired exp), signed
// with the REAL secret — to prove that claim checks (exp/iss/aud) fire independently of the signature.
export async function forgeSignedWithRealSecret(
  claims: ForgeClaims,
  secret: string
): Promise<string> {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const payload = b64urlJson(claims)
  const signingInput = `${header}.${payload}`
  const sig = await hmacSha256(secret, signingInput)
  return `${signingInput}.${b64url(sig)}`
}
