import { applyD1Migrations, env } from 'cloudflare:test'

// Runs once per test file (setupFiles), BEFORE any test, outside per-test storage isolation.
// applyD1Migrations is idempotent (records state in d1_migrations), so re-runs are safe.
// TEST_MIGRATIONS is injected by vitest.config.ts via readD1Migrations(); it exists only in tests.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    TEST_MIGRATIONS: D1Migration[]
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
