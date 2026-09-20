# Plan: daemon-side pairing-over-tunnel + gateway device registration

**Status:** draft for review · **Branch:** `feat/mobile-remote`

## Why

The mobile remote feature's components, crypto, gateway routes, and (now) the web boot
path are all built + unit-tested, but the **cross-system pairing handshake was never
assembled**. Live acceptance proved it: the daemon never processes the phone's pairing
Hello (no SAS), and `confirmPairing` only writes the *local* device row — the gateway's
D1 never gets one, so `/pair/session` 403s and the phone's relay socket can never
authenticate. The data tunnel (paired phone → `/api` → loopback) is already wired; only
the **pairing control-plane over the tunnel** is missing.

This plan completes that, end to end, preserving every existing invariant (desktop is the
trust root; gateway is an opaque relay; E2E phone↔daemon; no silent detection).

## The wire contract (already spoken by the phone; the daemon must match)

Pairing rides the gateway `/relay/pair` ↔ `/relay/daemon` sockets as **JSON text frames**,
forwarded opaque by the relay. On the daemon they arrive on the tunnel socket with
`isBinary === false` (data-tunnel frames are binary; pairing frames are text).

```
phone  → daemon : {"t":"hello","devicePublicKey":<b64url32>,"sessionSalt":<b64url32>,"proposedName"?:string}
daemon → phone  : {"t":"pair-ack","daemonPublicKey":<b64url32>,"daemonId":string,"deviceId":string,"protocolVersion":2}
   ... human compares the 6-digit SAS on phone vs desktop, confirms ON THE DESKTOP ...
daemon → phone  : {"t":"confirmed","deviceId":string}
phone  → gateway: POST /pair/session {daemonId,deviceId}   (mints the device-bound cookie)
```

The phone's `boundJti` (its unpaired-session jti, needed by `/pair/confirm` and matched by
`/pair/session`) is **not** in the Hello — the phone can't read its own jti (HttpOnly
cookie). The gateway conveys it (design decision D2 below).

## Design decisions (the part to review)

- **D1 — pairing association is one-at-a-time per daemon.** The relay already allows a
  single active pair socket per daemon (replaces older with 4409). The daemon tracks one
  "active tunnel pairing" and maps an inbound Hello to its single `awaiting_handshake`
  pending pairing. The SAS (human-verified) is the binding security check, so a coarse
  association is safe.
- **D2 — `boundJti` is conveyed daemon-ward by the gateway**, not by the phone. The relay's
  `peer-online` control frame for `role:'pair'` gains a `jti` field; the daemon captures it
  for the active pairing and uses it as `boundJti` when calling `/pair/confirm`. (The phone
  literally cannot read its own jti.)
- **D3 — `confirmed` is sent AFTER the gateway device row exists.** On desktop confirm the
  daemon: (1) inserts the local device row (existing trust-root write), (2) `await`s
  `POST /pair/confirm` to the gateway (creates the gateway device row with `boundJti`),
  (3) only then sends `{t:"confirmed"}` to the phone. Ordering guarantees the phone's
  subsequent `/pair/session` finds the row (no 403 race).
- **D4 — the gateway stays opaque.** It does NOT parse pairing frames (it already forwards
  them verbatim). The only gateway change is adding `jti` to the pair `peer-online` control
  frame it already emits — routing metadata, not pairing semantics.
- **D5 — `/pair/confirm` is daemon-token-authed over HTTPS**, separate from the wss tunnel.
  A small daemon-side gateway HTTP client posts it (daemon token + gateway URL from
  app_state, same source `hive remote login` writes).

## Steps

### 1. Gateway: convey the phone jti to the daemon (`gateway/src/relay-do.ts`)
- When a `role:'pair'` socket attaches, the `notifyPeers(daemonId, {t:'peer-online',
  role:'pair'}, ...)` call gains `jti: attach.jti`.
- Test (`gateway/test/pairing-relay.test.ts`): a pair-socket attach delivers a
  `peer-online` control frame to the daemon socket carrying the pairing session's jti.
  Mutation: drop the field → assert fails.

### 2. Daemon: pairing-frame transport on the tunnel (`src/server/remote-tunnel.ts` + new `src/server/remote-pairing-tunnel.ts`)
- `onMessage` `!isBinary` branch: after HB_PONG / GW_CONTROL_PREFIX, if the text parses to a
  pairing envelope (`{t:"hello"|...}`), route to the pairing-tunnel driver. Add a
  `sendPairing(obj)` that JSON-stringifies + sends over the socket (the relay fans daemon→
  frames to the pair socket).
- Capture `jti` from the `peer-online` (role:'pair') control frame (`onControl`) → set as
  the active pairing's `boundJti`.
- New `remote-pairing-tunnel.ts` driver, injected with the pairing engine + a `send` fn +
  the gateway client + the device-confirm hook:
  - on `hello`: `submitDeviceHello({pairingId: <active>, devicePublicKey, sessionSalt,
    proposedName})` → `getHandshakeReply` → `sendPairing(pair-ack)`.
  - expose `onDesktopConfirm(pairingId, name)` (called by the confirm route, step 4).
- Tests (`tests/unit/remote-pairing-tunnel.test.ts`): hello→pair-ack with correct
  daemonPublicKey/ids; boundJti captured from peer-online; unknown/expired pairing ignored.
  NO PTY/node-pty.

### 3. Daemon→gateway HTTP client (`src/server/remote-gateway-client.ts`)
- `postPairConfirm({deviceId, devicePubkey, name, boundJti})`: POST `${gatewayUrl}/pair/confirm`
  with `Authorization: Bearer <daemonToken>` (both from app_state via the config source);
  body `{deviceId, devicePubkey, name, boundJti}` (devicePubkey base64url — match the
  gateway `str(body,'devicePubkey')` + the existing `pairing-relay.test.ts` shape).
- Returns ok / throws on non-2xx. Injectable fetch for tests.
- Tests: real `node:http` fixture (like `hive-remote-gateway-wire.test.ts`), assert method,
  path, bearer header, body fields. Mutation-checked.

### 4. Wire the confirm path (`src/server/remote-pairing.ts` confirmPairing + `routes-remote.ts`)
- The desktop confirm route (`POST /api/remote/pairings/:id/confirm`, already desktop-gated
  = trust root) drives: `confirmPairing` (local row, existing) → capture devicePubkey +
  boundJti from the pending pairing → `await postPairConfirm(...)` → `sendPairing(confirmed)`
  to the phone. If the gateway POST fails, surface the error and do NOT send `confirmed`
  (the local row exists but the phone won't be told it succeeded — it can retry/rescan).
- `confirmPairing` must expose the devicePubkey + the captured boundJti to the route (or the
  driver owns the whole confirm sequence). Decide: driver owns it (cleaner — single place).
- Tests: confirm → local insert + gateway POST called with the right deviceId/boundJti/
  devicePubkey + `confirmed` sent, in that order; gateway-POST failure → no `confirmed`.

### 5. Web: confirm the phone path is complete
- The pairing-client already speaks the wire protocol; `boundJti` in the Hello is optional
  and omitted (the gateway supplies it) — verify connect-flow/MobileEntry need no change
  beyond what's committed. Drop the now-dead `boundJti` dep plumbing if unused, OR leave a
  comment that the authoritative jti flows gateway→daemon (don't reintroduce the
  unreadable-cookie path). Add/adjust a test only if a real gap surfaces.

### 6. Verify, deploy, real-phone E2E
- Full suites (main + gateway + web) green; biome; adversarial verify pass (security:
  boundJti can't be spoofed by the phone; correctness: confirmed-after-gateway-confirm
  ordering; the data tunnel still works post-pair).
- `ship-bundle --bake` + `wrangler deploy` (gateway) ; restart daemon.
- Real phone: scan → SAS shows on both → confirm on desktop → `hive remote devices` lists
  the phone → the phone reaches the real Hive UI over the tunnel.

## Risks / watch-items
- **Pairing association** (D1): if two phones race the same daemon, the second replaces the
  first's pair socket (relay 4409). The driver must reset its active-pairing state on a new
  peer-online so a stale handshake can't be confirmed. Test the replace path.
- **boundJti timing**: the `peer-online` (with jti) must arrive before `confirmPairing`
  posts. It does (peer-online is emitted on pair-socket attach, before any Hello). Guard:
  if boundJti is missing at confirm time, fail the confirm with a clear error rather than
  posting a bad `/pair/confirm`.
- **Daemon restart mid-pairing**: pending pairings are in-memory; a restart invalidates them
  (existing constraint). The scan-to-pair self-heal (already shipped) lets the user re-scan.
- **`confirmed` delivery**: daemon→ frames fan out to device sockets too; a stray `confirmed`
  string to a data socket is ignored (not a frame). Acceptable.

## Out of scope (separate follow-ups)
- 30-day device-cookie expiry re-auth (re-scan re-pairs today).
- Store-key normalization for self-host gateway origins (prod default works).
- Tunnel auto-reconnect UX banner.
