// Make `env` from 'cloudflare:test' carry the full gateway Env so tests read secrets/config with
// types. Declaration-merges with the partial ProvidedEnv in test/apply-migrations.ts (DB +
// TEST_MIGRATIONS) — TS merges same-named interfaces; the property types match the real Env.
import type { Env } from '../../src/env.js'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
    // Mock R2 bucket bound by vitest.config.ts (miniflare r2Buckets:['ASSETS']) for the bundle serve
    // path. Declared here so the seed helper types env.ASSETS even before src/env.ts adds the binding;
    // when Env also declares ASSETS:R2Bucket the merge is additive (same name + type).
    ASSETS: R2Bucket
  }
}
