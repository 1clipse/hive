# Remote access (use Hive from your phone)

Remote access lets you open the **full Hive web UI** from a phone browser — anywhere,
on any network — while Hive keeps running on your computer. A paired phone is an
**equal-authority** client: it sees the same workspaces, terminals, task graphs, and
settings as the browser tab on your desktop, over an end-to-end encrypted tunnel.

It is **off by default**. Until you turn it on and link your machine, Hive listens only
on `127.0.0.1` and makes no outbound connections — exactly as before.

> Remote access is optional. It needs a gateway to relay traffic between your phone and
> your machine. You can run your own (see [Self-hosting a gateway](#self-hosting-your-own-gateway))
> or use a hosted one. There is no turnkey hosted service bundled with Hive today; the
> default gateway URL (`https://app.hivehq.dev`) is just the configured default, not a
> guarantee of availability.

## How it works (security model)

```
[phone browser] --wss (ciphertext)--> [gateway] <--outbound wss (ciphertext)-- [your machine: Hive]
       same Hive web UI                 OAuth login          your data + agents never leave here
                                        account -> machine -> device routing (opaque relay)
```

A few properties are load-bearing and worth understanding before you turn this on:

- **End-to-end encrypted.** Every frame between your phone and your machine is encrypted
  with keys established during pairing (X25519 + HKDF, XChaCha20-Poly1305). The gateway
  relays ciphertext and routing headers only — it never sees your terminals, your code,
  or your traffic in the clear.
- **The cloud does identity + routing only.** Data and execution stay on your machine. If
  the gateway is down, remote access stops working, but local Hive on `127.0.0.1` is
  completely unaffected. The gateway never runs your agents or stores your project data.
- **Opaque relay.** The gateway can map "account → which machine → which device," and it
  can refuse or drop a connection (that is how revocation works). It cannot read what
  flows through.
- **Desktop-confirm trust root.** A new device can only be paired by approving it **on the
  desktop** with a matching short code (SAS). A phone — even an already-paired one — can
  never approve another device. This is the one ceremony Hive deliberately keeps on the
  computer.
- **The tunnel only reaches Hive's own API.** The loopback bridge that the tunnel feeds is
  path-whitelisted to Hive's `/api/*` and `/ws/*`. It is not a general localhost proxy and
  cannot reach other services on your machine.

### Honest limit: the phone's crypto code is served by the gateway

The encryption above runs in JavaScript that the **phone downloads from the gateway**.
This is the well-known limit of any browser-delivered end-to-end encryption (the same
caveat applies to Proton Mail's web app, WhatsApp Web, etc.): you are trusting the gateway
to serve honest crypto code, even though it can't read the resulting ciphertext.

Hive mitigates this but does not pretend it away:

- The bundle is **version-pinned with Subresource Integrity (SRI)** — the loader refuses to
  run a bundle whose hash doesn't match what the daemon expects for its version.
- The PWA service worker caches the bundle, so after the first load you keep running the
  code you already vetted (trust-on-first-use).

We do **not** claim "secure even if the gateway is compromised." A compromised gateway's
worst case is denial of service plus the ability to attempt serving a malicious bundle
(which SRI + the cached service worker are there to blunt). It still cannot decrypt past
traffic. If you want to remove the gateway from your trust surface entirely, run your own.

## Enabling remote access

Two steps: turn the feature on, and link your machine to an account.

1. **Turn it on.** In the desktop web UI, open **Settings → Remote access** and toggle it
   on. While off, none of the device controls render and the daemon opens no outbound
   connection.
2. **Link this machine** with the CLI (next section). Linking also flips the toggle on for
   you.

You can disable it again any time from the same toggle, or with `hive remote logout`. A
**paired phone can turn remote access off** (it disconnects itself, after a confirm) but
**cannot turn it back on** — re-enabling is desktop-only, because with no tunnel there is
physically nothing for the phone to talk to.

## Linking your machine: `hive remote login`

Run this on the computer where Hive runs:

```
hive remote login
```

It prints an approval URL and a short code, then waits:

```
To link this machine, open the approval page in a browser where you are
logged in to your Hive account, and confirm the code matches:

  https://app.hivehq.dev/daemon/approve?code=ABC123

  Code: ABC123

Waiting for approval…
```

Open that URL in a browser, sign in with **GitHub or Google** (your first sign-in
registers the account — no password is stored), and approve the code. The CLI picks up the
approval, stores an account-scoped token locally, and enables remote access:

```
This machine is linked. Remote access is now enabled.
Restart the Hive runtime (or it will connect on next start) to bring
the tunnel online. Pair a phone from Settings → Remote access.
```

The token is local RCE on this machine, so it is written to Hive's local database and
**never printed back**. Other subcommands:

| Command | What it does |
|---|---|
| `hive remote login [--gateway <url>]` | Link this machine to your account. `--gateway` overrides the default gateway URL. |
| `hive remote status` | Show whether remote is enabled, whether you're logged in, the gateway, and this machine's id. |
| `hive remote logout` | Forget the gateway token and disable remote access. |
| `hive remote devices` | List this machine's paired devices (name, last activity, revoked state). |
| `hive remote revoke <deviceId>` | Revoke a paired device on this machine. |

> `hive remote devices` / `revoke` operate on **this daemon's own device store** — the
> source of truth that holds each device's session keys — so a revoke here actually stops the
> daemon from decrypting that device's traffic. A CLI revoke takes effect on the device's next
> connection; to tear down an **in-progress** session immediately, revoke from **Settings →
> Remote access** (which fires the live disconnect). The Settings panel works from the desktop
> or a paired phone. See [Revoking a device](#revoking-a-device).

One account can be linked to multiple machines and multiple phones. Hive does not do
sharing, collaboration, or multi-user authorization — an account is a single owner.

## Adding a device (desktop code → phone entry → desktop confirm)

Pairing always involves both the desktop and the phone, by design. The desktop is the
trust root.

**On the desktop:**

1. With remote access enabled and the machine linked, open **Settings → Remote access** and
   click **Add device**.
2. A short pairing code appears with a live countdown. It is **one-time and
   short-lived** (regenerate if it expires).

**On the phone:**

3. Open the gateway URL in your phone's browser and sign in with the same GitHub/Google
   account.
4. Pick this machine from the list, type the pairing code shown on the desktop, and submit
   it. The phone derives its session keys and shows a **6-digit code (SAS)**.

**Back on the desktop:**

5. A confirmation dialog pops up showing the new device's name and the same 6-digit code.
   **Compare the codes** — they must match — then click **Confirm**. Only this confirm
   actually persists the device; rejecting, closing, or letting it time out leaves nothing
   paired.

After confirm, the phone's session is established and it loads the Hive UI. The matching
codes are what protect you against a man-in-the-middle during pairing: if the codes differ,
do not confirm.

> The "Add device" button does not appear on the phone. Approving a new device is
> desktop-only, and paired devices are managed from the desktop Settings panel or the
> host CLI.

## Using the phone UI

Once paired, the phone runs the same Hive runtime as your desktop, re-laid out for a
small screen — bottom navigation and full-screen Team / Tasks panels instead of the
three-pane desktop layout. Trust-root controls stay desktop-side.

What you can do from the phone:

- Browse, switch, create, and delete workspaces.
- Create, start, stop, restart, rename, and delete agents.
- **Read and write any terminal**, including worker terminals. Tap directly into the
  terminal to type; worker terminals open full-screen on phones, and WebGL falls back to
  canvas where unavailable.
- View and edit the task graph.
- Use desktop Settings or `hive remote devices` / `hive remote revoke` on the host to
  manage paired devices and audit remote access.

A few things behave differently for physical reasons, not because of permission trimming:

- **Adding a workspace** uses manual path entry plus server-side browse, since a native OS
  folder picker can't pop on your computer from a phone.
- **Open in editor / Finder** runs the action **on the computer** and shows you a toast on
  the phone confirming it.

## Revoking a device

From either the desktop or the phone, open **Settings → Remote access**, find the device in
the list, and revoke it. A phone can revoke any device, including itself (with a confirm).
Revocation is immediate: the device's live tunnel is dropped and any new connection from it
is refused. Revocation is also a tombstone — a revoked device can't be un-revoked, you pair
again from scratch.

> On the machine itself you can also run `hive remote devices` to list paired devices and
> `hive remote revoke <deviceId>` to revoke one — these act on the daemon's local device
> store. A CLI revoke is refused on the device's next connection; for an immediate live
> disconnect of an in-progress session, use the Settings panel above.

## Self-hosting your own gateway

The gateway is an opaque relay — it never sees your data — but if you'd rather not trust
anyone else's, the daemon's gateway URL is configurable. Point Hive at your own:

```
hive remote login --gateway https://gateway.example.com
```

(or set it once and `hive remote status` will report it).

The gateway runs on **Cloudflare Workers** (Durable Objects for per-account relay, D1 for
the small users/daemons/devices/sessions tables). Deploying one means:

- Creating the D1 database and applying its migrations.
- Setting the OAuth + signing secrets via `wrangler secret put`
  (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
  `JWT_SIGNING_SECRET`).
- Deploying with `wrangler` and attaching your domain.

The full design rationale — why there's a cloud component at all, and the strict boundary it
stays inside — is recorded in [design decisions](./design-decisions.md).
