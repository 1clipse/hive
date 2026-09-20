import path from 'node:path'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

// Read every migrations/*.sql at config time (Node context) so tests can apply them to the
// per-file isolated D1 before touching the DB. The array is handed to the worker as a TEST-ONLY
// binding (TEST_MIGRATIONS); the setup file calls applyD1Migrations(env.DB, env.TEST_MIGRATIONS).
const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        // WebSocket-in-DO + DO storage aren't supported under per-file storage isolation, and the
        // relay/rate-limit DO suites need a single shared runtime. isolatedStorage:false +
        // singleWorker:true is the hard runtime constraint (relay wins); DB/limiter suites reset
        // their own rows via DELETE FROM / fresh keys in beforeEach/afterEach instead of relying on
        // storage isolation. applyD1Migrations is idempotent so the schema persists across the run.
        isolatedStorage: false,
        singleWorker: true,
        miniflare: {
          // Mock R2 bucket for the versioned mobile-bundle serve path (M6.2). Miniflare gives an
          // in-memory R2 bound as env.ASSETS — same binding name as wrangler.toml's [[r2_buckets]].
          // The bundle serve-path suite seeds it (beforeAll) with the realistic hash-named fixture and
          // re-verifies served bytes against the WORKER-anchored manifest, never against R2. With
          // isolatedStorage:false the bucket persists for the run, so one seed covers the whole suite.
          r2Buckets: ['ASSETS'],
          // TEST bindings only — dummy secrets, and OAuth provider base URLs pointed at the
          // in-worker mock. NEVER real secrets, NEVER real network to GitHub/Google in tests.
          // Secrets are DISTINCTIVE SENTINELS so the secret-hygiene suite can grep success/error
          // bodies + console + Set-Cookie and prove nothing ever leaks them.
          bindings: {
            TEST_MIGRATIONS: migrations,

            JWT_SIGNING_SECRET: 'test-sentinel-jwt-DO-NOT-LEAK',
            GITHUB_CLIENT_ID: 'test-gh-client-id',
            GITHUB_CLIENT_SECRET: 'test-sentinel-gh-DO-NOT-LEAK',
            GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-sentinel-google-DO-NOT-LEAK',

            // Point providers at an in-worker mock origin (a test-only Hono sub-app serves these).
            // Google's token endpoint is a separate host in prod (oauth2.googleapis.com), so it's a
            // separate var here too — composed off its own mock path, never off GOOGLE_OAUTH_BASE.
            GITHUB_OAUTH_BASE: 'https://mock.test/gh/login/oauth',
            GITHUB_API_BASE: 'https://mock.test/gh/api',
            GOOGLE_OAUTH_BASE: 'https://mock.test/google/o/oauth2/v2',
            GOOGLE_TOKEN_URL: 'https://mock.test/google/token',
            GOOGLE_JWKS_URL: 'https://mock.test/google/certs',
            GOOGLE_ISSUER: 'https://accounts.google.com',

            GATEWAY_ORIGIN: 'https://app.hivehq.dev',

            // TEST-ONLY (unset in prod): names a header the rate limiter may read as a client-IP
            // fallback ONLY when CF-Connecting-IP is absent. Lets a test drive distinct IP buckets
            // without the edge header; the spoof-resistance test proves CF-Connecting-IP still wins.
            RATELIMIT_TEST_IP_HEADER: 'X-Hive-Test-Ip',
          },
        },
      },
    },
  },
})
