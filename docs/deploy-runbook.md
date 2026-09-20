# Gateway Deploy Runbook (owner-only)

> The gateway source is maintained in `tt-a1i/hive`, separately from the npm package.
> Deployments require your Cloudflare account, OAuth apps, and secrets. Forks must
> replace the hosted domain and D1 binding with their own before deployment.

The gateway does exactly two jobs: **identity** (OAuth login, sessions, daemon binding) and
**routing** (the opaque relay). It never decrypts terminal/API content — that's end-to-end between
the phone and your daemon. Remote access is **off by default**; nothing below changes behavior for a
user who never turns it on.

The CI half is `.github/workflows/gateway-deploy.yml`:
- `deploy-gateway` — manual `workflow_dispatch` (type `deploy` to confirm) → `wrangler deploy` from `gateway/`.
- `upload-bundle` — on a `v*` release tag → builds the web bundle, emits a sha384 SRI manifest, keeps it as an artifact, and pushes to R2 if an R2 bucket is wired.

The first deploy is done by hand from your laptop (steps 1–9). After that, CI can redeploy.

---

## 0. Prerequisites (one-time)

- A Cloudflare account with Workers + D1 enabled.
- `wrangler` v4 (`pnpm -C gateway install` brings it in; or `npm i -g wrangler`).
- The domain `hivehq.dev` added to that Cloudflare account as a zone (DNS managed by CF). The gateway is served at the subdomain **`app.hivehq.dev`** (step 8).
- A registered **GitHub OAuth App** and **Google OAuth Client** (step 6 needs their client id/secret). Register them now; Google's production verification has a multi-week lead time, so submit early and use the testing-mode client until it clears.
  - GitHub callback URL: `https://app.hivehq.dev/auth/github/callback`
  - Google authorized redirect URI: `https://app.hivehq.dev/auth/google/callback`

All commands below run from the `gateway/` directory unless noted.

---

## 1. Authenticate wrangler

```bash
cd gateway
wrangler login
```

This opens a browser to authorize wrangler against your Cloudflare account. (For CI, instead create a scoped API token — see step 9.)

## 2. Create the D1 database

The binding in `gateway/wrangler.toml` is `DB`, with `database_name = "hive-gateway"`.
The checked-in `database_id` belongs to the hosted Hive gateway. Self-hosters must
create their own database and replace that ID:

```bash
wrangler d1 create hive-gateway
```

Copy the printed `database_id` and paste it into `gateway/wrangler.toml`, replacing
the hosted instance ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hive-gateway"
database_id = "<the-uuid-wrangler-printed>"
migrations_dir = "migrations"
```

> CI rejects the literal placeholder, but cannot prove database ownership. Verify
> that the ID belongs to your account before applying migrations or deploying.

## 3. Apply migrations to the remote database

`migrations_dir` points at `gateway/migrations/` — currently `0001_init.sql` (users / daemons /
devices / sessions / revocations / daemon_codes) and `0002_pairing.sql` (the `bound_session_jti`
column). Apply them against the **remote** D1 you just created:

```bash
wrangler d1 migrations apply hive-gateway --remote
```

Confirm with `wrangler d1 migrations list hive-gateway --remote` — both should show as applied.

## 4. Add the production `[vars]` to wrangler.toml

The worker reads non-secret config from `c.env` (see `gateway/src/env.ts`). In tests these come from
the miniflare bindings; for prod they must be set as `[vars]` in `gateway/wrangler.toml`. Add:

```toml
[vars]
GATEWAY_ORIGIN  = "https://app.hivehq.dev"
GITHUB_OAUTH_BASE = "https://github.com/login/oauth"
GITHUB_API_BASE   = "https://api.github.com"
GOOGLE_OAUTH_BASE = "https://accounts.google.com/o/oauth2/v2"
GOOGLE_TOKEN_URL  = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_URL   = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUER     = "https://accounts.google.com"
```

`GATEWAY_ORIGIN` is the canonical https origin: it is the OAuth `redirect_uri` base and the
open-redirect allowlist root, so it MUST equal the custom domain you attach in step 8. These are not
secrets (they're public provider URLs) — they belong in `wrangler.toml`, not in `wrangler secret`.

## 5. (Optional, but recommended) wire the R2 bundle store

Out of the box the gateway serves a byte-verified **in-worker placeholder** bundle
(`gateway/src/bundles.ts`), so `/app` and `/assets/v0/*` work immediately with real SRI. To serve the
actual versioned web bundle the release job uploads, create an R2 bucket and bind it:

```bash
wrangler r2 bucket create hive-gateway-assets
```

Then add to `gateway/wrangler.toml`:

```toml
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "hive-gateway-assets"
```

and set the repo Actions **variable** `ASSETS_R2_BUCKET=hive-gateway-assets` (Settings → Secrets and
variables → Actions → Variables) so the `upload-bundle` job pushes there. Until R2 is wired, the
placeholder stays in effect and the upload job just keeps the bundle as a build artifact.

> Reading the R2 bytes in the serve path is a follow-up wiring task in `bundles.ts`; the SRI contract
> (loader pins sha384, route re-verifies the served bytes) is already enforced for whatever store is
> active.

## 6. Set the five worker secrets

Secrets never go in `wrangler.toml` or CI — only via `wrangler secret put` (it prompts for the value,
nothing is echoed). Set all five against the prod worker:

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put JWT_SIGNING_SECRET
```

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from the GitHub OAuth App.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from the Google OAuth Client. (`GOOGLE_CLIENT_ID` is also the audience the Google `id_token` must match.)
- `JWT_SIGNING_SECRET` — HS256 key for the gateway's own session JWTs. Generate a fresh, high-entropy value, e.g. `openssl rand -base64 48`. Rotating it invalidates all existing sessions.

Verify they're all present: `wrangler secret list`.

## 7. Deploy

> **Plan B (current setup — R2 not activated): bake the mobile bundle into the worker.** R2 is disabled
> on this account, so the worker ships the real bundle bytes in-process. You MUST regenerate the baked
> bundle right before deploying, or the worker would ship the empty placeholder (a phone would load
> nothing). The committed `bundle-*.generated.ts` are intentionally the small test fixture — `--bake`
> overwrites them with the real bytes transiently for the deploy:
>
> ```bash
> pnpm build:web                                                   # → web/dist
> node gateway/scripts/ship-bundle.mjs --dist web/dist --version <v> --bake
> (cd gateway && wrangler deploy)                                  # ships the worker WITH the real baked bundle
> git checkout gateway/src/bundle-manifest.generated.ts gateway/src/bundle-assets.generated.ts  # repo back to the fixture
> ```
>
> `<v>` is the bundle version the loader serves (use the current `package.json` version); it is self-consistent (loader + R2/baked
> keyspace all derive from it). The deploy reports the gzipped worker size — it must stay under the free
> 3 MB limit (the current bundle is ~585 KB gzipped). To switch to the cloud-native R2 path later, enable
> R2, re-add the `[[r2_buckets]]` binding (§5), and re-ship WITHOUT `--bake` (bytes go to R2 instead).

```bash
wrangler deploy
```

Sanity-check the worker is live (replace with the workers.dev URL wrangler prints, until step 8):

```bash
curl -sS https://<your-worker>.workers.dev/healthz   # => ok
```

## 8. Attach the custom domain `app.hivehq.dev`

Uncomment the route in `gateway/wrangler.toml`:

```toml
routes = [{ pattern = "app.hivehq.dev", custom_domain = true }]
```

Re-deploy (`wrangler deploy`). Cloudflare provisions the cert and DNS for the custom domain. Confirm:

```bash
curl -sS https://app.hivehq.dev/healthz   # => ok
curl -sSI https://app.hivehq.dev/app | grep -i content-security-policy   # require-sri-for script present
```

> `app.hivehq.dev` must match `GATEWAY_ORIGIN` (step 4) and the OAuth callback URLs (step 0), or login
> redirects will be rejected by the open-redirect allowlist.

## 9. (Optional) enable CI redeploys

So `.github/workflows/gateway-deploy.yml` can deploy without your laptop:
- Create a Cloudflare API token scoped to **Workers Scripts:Edit, D1:Edit, Workers R2 Storage:Edit** for this account.
- Add repo Actions **secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Create the `gateway-production` repo **environment** (Settings → Environments) and add a required reviewer (you) so a deploy needs an approval click.
- Redeploy from the Actions tab → **Gateway Deploy** → Run workflow → type `deploy`.

The bundle-upload job runs automatically on the next `v*` release tag; nothing to trigger.

## 10. Point a daemon at the gateway

The daemon's gateway URL is configurable and defaults to `https://app.hivehq.dev`
(`src/server/remote-config-keys.ts` → `DEFAULT_GATEWAY_URL`). To bind a machine:

```bash
hive remote login                 # uses the default gateway
# or, for a self-hosted gateway:
hive remote login --gateway https://your-gateway.example.com
```

It prints a one-time code + an approve URL; approve it in your logged-in browser, and the daemon
exchanges the code for a long-term token. `hive remote status` shows the connection; `hive remote
logout` forgets the token and turns remote access off again.

> `hive remote devices` / `hive remote revoke <deviceId>` operate on the daemon's LOCAL device
> store (the source of truth holding each device's session keys) — no gateway round-trip — so they
> work regardless of the gateway. A CLI revoke is refused on the device's next connection; an
> in-progress session is torn down live by revoking from Settings → Remote access in the web UI.

---

## Live acceptance checklist

Run this against the real `app.hivehq.dev` after a deploy. None of it is covered by the automated
suites (those use mock providers / a fake gateway / a simulated phone); this is the part that needs a
real account and a real phone. Do NOT consider the gateway shipped until every box is checked.

### Identity
- [ ] `GET https://app.hivehq.dev/healthz` returns `ok`.
- [ ] **GitHub login**: open `/`, sign in with GitHub, land on the machine list. First login creates the account (no password).
- [ ] **Google login**: same, with a Google account. (If Google is still in testing mode, use a whitelisted test account and confirm the consent screen.)
- [ ] `wrangler tail` shows no errors during either login.

### Daemon binding
- [ ] `hive remote login` on a real machine prints a code; approving it in the browser flips the daemon to connected (`hive remote status`).
- [ ] The bound machine appears in the gateway's machine list for that account.

### Real-phone pairing (the deferred M4/M5 live test)
- [ ] On the desktop Hive UI, Settings → Remote access → Add device shows a short-lived pairing code.
- [ ] Enter that code on a real phone; the phone reaches the pairing screen and shows a 6-digit SAS.
- [ ] The **desktop** shows a confirm dialog with the same device name + SAS. The SAS on phone and desktop **match**.
- [ ] Confirm on the desktop → the phone connects and loads the full Hive UI. (Approving on the phone alone must NOT pair — trust root is desktop-only.)
- [ ] A revoked / tampered pairing does not connect.

### Equal-authority flow (phone == desktop)
- [ ] From the phone over 4G/5G (not same LAN): switch workspaces, create/start/stop/restart an agent, and confirm it reflects on the desktop.
- [ ] Orchestrator and worker **terminals are writable** from the phone; output streams back.
- [ ] Tasks graph is viewable and editable from the phone.
- [ ] **Add workspace from the phone** uses manual path entry + browse/probe (never the desktop OS folder picker).
- [ ] New-device / first remote session fires a desktop notification.

### Mobile input (IME — the real-device requirement)
- [ ] **iOS Safari**: tap directly into a terminal and type, including an IME (e.g. Pinyin/Japanese) — composition commits once, no duplicated/dropped characters.
- [ ] **Android Chrome**: same direct-terminal input + IME checks.
- [ ] Lock the phone / switch networks and return: the session reconnects and the terminal restores from snapshot.

### Revoke + kill-switch
- [ ] Revoke the paired device from desktop Settings or the host CLI: its live streams drop immediately and it can't reconnect.
- [ ] Toggling Remote access **off** from desktop Settings self-disconnects remote sessions; it cannot be turned back **on** from a phone (no tunnel == physically impossible).

### Integrity / hygiene
- [ ] `curl -sSI https://app.hivehq.dev/app` shows `Content-Security-Policy: ... require-sri-for script ...` and the served loader's `<script integrity="sha384-...">` matches the manifest.
- [ ] `wrangler tail` shows no secret values, no stack traces leaking config, during the full run.
- [ ] Try a tunneled request to a non-whitelisted path (anything outside `/api/*` and `/ws/*`): the daemon bridge rejects it (path-denied in the audit log), proving the relay isn't a general localhost proxy.

When every box is checked, the gateway is live and the remote-access feature is end-to-end verified.
The release tag + npm publish stays owner-gated (see `docs/release.md`).
