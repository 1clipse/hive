// Worker environment bindings + injected config. There is ONE source of truth for what the
// gateway can touch: this interface. Everything reaches the rest of the code via `c.env`.
//
// TESTABILITY (binding spec rule): the OAuth provider endpoints are NOT hardcoded — they are
// base-URL strings read from here. Production wrangler.toml [vars] sets the real URLs; tests set
// them (via poolOptions.workers.miniflare.bindings in vitest.config.ts) to an in-worker mock so the
// full authorize/callback/token/userinfo/JWKS flow runs with ZERO real network to GitHub/Google.
//
// SECRETS come ONLY from wrangler secrets (`wrangler secret put`) / gateway/.dev.vars / the test
// miniflare bindings — never committed, never logged, never echoed in a response.

// Type-only imports (erased under verbatimModuleSyntax) — tighten the DO bindings without a runtime
// cycle: relay-do.ts / rate-limit.ts import Env from here, but a `import type` never emits a require,
// so there's no loop. RELAY.get(...) / RATELIMIT.get(...) then return stubs typed to the RPC surface.
import type { RateLimitDO } from './rate-limit.js'
import type { RelayDO } from './relay-do.js'

export interface Env {
  // --- Cloudflare resource bindings (wrangler.toml) ---
  DB: D1Database
  // Per-account opaque relay DO. Tightened to the concrete class so RELAY.get(...) returns a stub
  // exposing the RelayDO RPC surface (revoke()) to the Worker.
  RELAY: DurableObjectNamespace<RelayDO>
  // Per-key sliding-window rate-limit DO (login / approve / code-exchange). One DO instance per
  // bucket key (idFromName(`${endpoint}:${key}`)), so each key serializes its own consume() calls.
  RATELIMIT: DurableObjectNamespace<RateLimitDO>

  // Versioned web-bundle store. Holds the immutable, hash-named Vite output under keys
  // assets/<version>/<path> (CI uploads it on a release tag). The serve route reads bytes from here
  // and RE-VERIFIES them against the worker-anchored sha384 manifest before serving — the manifest is
  // never read from R2, so a swapped R2 byte loses (502). Unbound in local dev / tests → the route
  // falls back to the in-worker placeholder, so nothing here is required for the gateway to boot.
  ASSETS?: R2Bucket

  // --- Secrets (wrangler secret put / .dev.vars / test bindings) ---
  JWT_SIGNING_SECRET: string // HS256 key for our own session JWTs
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GOOGLE_CLIENT_ID: string // also the audience the Google id_token must match
  GOOGLE_CLIENT_SECRET: string

  // --- Injectable provider base URLs ([vars] in prod; mock in tests) ---
  // No trailing slash. Code composes paths off these; nothing else hardcodes a provider host.
  GITHUB_OAUTH_BASE: string // authorize + token, e.g. https://github.com/login/oauth
  GITHUB_API_BASE: string // userinfo, e.g. https://api.github.com
  GOOGLE_OAUTH_BASE: string // authorize lives here (/auth), e.g. https://accounts.google.com/o/oauth2/v2
  // Google's token endpoint is a DIFFERENT host from authorize, so it can't be composed off
  // GOOGLE_OAUTH_BASE — it needs its own var. Prod: https://oauth2.googleapis.com/token; test: mock.
  GOOGLE_TOKEN_URL: string
  GOOGLE_JWKS_URL: string // id_token verification keys, e.g. https://www.googleapis.com/oauth2/v3/certs
  GOOGLE_ISSUER: string // expected id_token 'iss', e.g. https://accounts.google.com

  // --- Deployment config ([vars]) ---
  GATEWAY_ORIGIN: string // canonical https origin, e.g. https://app.hivehq.dev — OAuth redirect_uri base + open-redirect allowlist root
}

// The OAuth provider tag stored on users.provider. Single place the union is defined.
export type OAuthProvider = 'github' | 'google'

// Revocation keyspace discriminator (revocations.kind).
export type RevocationKind = 'session' | 'daemon' | 'device'
