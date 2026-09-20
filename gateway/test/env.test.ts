import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'

// Foundation contract: the Env shape + injected test bindings that EVERY later stage depends on.
// The testability invariant (binding spec rule) is that no provider host is hardcoded — each OAuth
// endpoint base is a string in Env, and tests point them at the in-worker mock origin so the full
// flow runs with ZERO real network. These asserts fail loudly if a binding is dropped or a real
// provider host leaks into the test config.

const MOCK = 'https://mock.test/'

test('all injectable provider base URLs resolve to the mock origin, never a real provider host', () => {
  // If any of these were hardcoded to a real host (oauth2.googleapis.com, github.com, …) the
  // testability invariant is broken: tests would hit the network. We assert they point at mock.test.
  for (const url of [
    env.GITHUB_OAUTH_BASE,
    env.GITHUB_API_BASE,
    env.GOOGLE_OAUTH_BASE,
    env.GOOGLE_JWKS_URL,
    env.GOOGLE_TOKEN_URL,
  ]) {
    expect(typeof url).toBe('string')
    expect(url.startsWith(MOCK)).toBe(true)
  }
})

test('GOOGLE_TOKEN_URL is its own binding (Google token host differs from authorize host)', () => {
  // Google's real token endpoint (oauth2.googleapis.com) lives on a DIFFERENT host from authorize
  // (accounts.google.com), so it cannot be composed off GOOGLE_OAUTH_BASE. The OAuth stage exchanges
  // the auth code against this exact URL; if it's missing the exchange has no endpoint.
  expect(env.GOOGLE_TOKEN_URL).toBeDefined()
  expect(env.GOOGLE_TOKEN_URL).not.toBe(env.GOOGLE_OAUTH_BASE)
  expect(env.GOOGLE_TOKEN_URL.endsWith('/token')).toBe(true)
})

test('secrets are present and distinct from the public client ids (no swap/empty)', () => {
  // A reversed/empty-secret impl would fail these. Secrets must be non-empty and never equal the
  // client id (a common copy-paste bug). Sentinel values let the hygiene suite catch leaks.
  expect(env.JWT_SIGNING_SECRET.length).toBeGreaterThan(0)
  expect(env.GITHUB_CLIENT_SECRET.length).toBeGreaterThan(0)
  expect(env.GOOGLE_CLIENT_SECRET.length).toBeGreaterThan(0)
  expect(env.GITHUB_CLIENT_SECRET).not.toBe(env.GITHUB_CLIENT_ID)
  expect(env.GOOGLE_CLIENT_SECRET).not.toBe(env.GOOGLE_CLIENT_ID)
})

test('GATEWAY_ORIGIN and GOOGLE_ISSUER are set for redirect-allowlist + id_token iss checks', () => {
  expect(env.GATEWAY_ORIGIN.startsWith('https://')).toBe(true)
  expect(env.GOOGLE_ISSUER.length).toBeGreaterThan(0)
})
