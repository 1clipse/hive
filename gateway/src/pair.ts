// M5a — pairing control-plane JSON (the trust spine for promoting an unpaired phone to a paired
// device). Three endpoints under /pair/* (deliberately NOT /api/* — the daemon API rides the E2E
// relay, never a gateway origin route):
//
//   POST /pair/confirm   daemon-token-authed   the ONLY device-row creator. The daemon calls this
//                        AFTER its local confirmPairing (M4 desktop confirm). A phone has no daemon
//                        token, so it can never self-promote (invariant 2).
//   POST /pair/session   unpaired-phone-session the phone exchanges its unpaired (deviceId=null)
//                        session for a device-bound (`did`) one — ONLY if the device row exists,
//                        is confirmed, owned by the caller, and its bound_session_jti matches the
//                        caller's jti. No /pair/confirm → no row → 403 (no mint).
//   GET  /pair/machines  any-session           the caller's OWN daemons + which are live (opaque) +
//                        whether THIS session is already paired (self.deviceId). Account-isolated.
//
// SECURITY:
//   - /pair/confirm is the single createDevice() call site; it is gated on a LIVE daemon token, so
//     only a real daemon (post-desktop-confirm) can create a device row. Invariant 2.
//   - /pair/session mints a device session ONLY when the row + bind line up. mint+revoke order:
//     REVOKE the old unpaired jti FIRST, THEN mint the did session, so a partial failure leaves the
//     phone needing to re-auth rather than holding two live sessions (HARDEN). The bind is cleared on
//     success (single-use), so a replay of the same body can't re-mint.
//   - every lookup is user_id-scoped (anti-IDOR): a caller can only confirm/mint/list within its
//     own account.

import { Hono } from 'hono'
import {
  clearDeviceBoundJti,
  createDevice,
  getDaemonsForUser,
  getDeviceById,
  getLiveDaemonByToken,
  revokeDevice,
  revokeSession,
} from './db.js'
import type { Env } from './env.js'
import {
  mintSession,
  PHONE_SESSION_TTL_MS,
  readSessionCookie,
  sessionFromRequest,
  sessionSetCookie,
} from './sessions.js'

export const pairRoutes = new Hono<{ Bindings: Env }>()

// Pull a bearer daemon token out of the Authorization header. The daemon authenticates here with the
// long-term token it holds (the gateway stores only its hash). No cookie path: a browser/phone can't
// reach this endpoint, which is exactly the self-promotion defense.
function bearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization')
  if (!auth) return null
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  const token = m?.[1]?.trim()
  return token && token.length > 0 ? token : null
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    if (typeof body === 'object' && body !== null) return body as Record<string, unknown>
  } catch {
    // malformed body
  }
  return null
}

function str(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

// POST /pair/confirm — daemon-token-authed. The ONLY device-row creator (invariant 2). The daemon
// calls this after the desktop confirms the pairing; it carries the pre-allocated deviceId, the
// device's X25519 pubkey, a display name, and the unpaired gateway-session jti the phone bound into
// its pairing Hello (so /pair/session can match it). Idempotent on the deviceId PK (a retried confirm
// is a no-op, not a duplicate).
pairRoutes.post('/confirm', async (c) => {
  const token = bearerToken(c.req.raw)
  if (token === null) return c.json({ error: 'unauthorized' }, 401)
  const daemon = await getLiveDaemonByToken(c.env.DB, token)
  if (!daemon) return c.json({ error: 'unauthorized' }, 401)

  const body = await readJson(c.req.raw)
  const deviceId = str(body, 'deviceId')
  const devicePubkey = str(body, 'devicePubkey')
  const name = str(body, 'name')
  const boundJti = str(body, 'boundJti')
  if (!deviceId || !devicePubkey || !name || !boundJti) {
    return c.json({ error: 'missing_fields' }, 400)
  }

  // Idempotent: if a row already exists it must belong to THIS account (a daemon can't confirm a
  // device onto another account — the daemon token pins daemon.user_id). A retried confirm is a no-op.
  const existing = await getDeviceById(c.env.DB, deviceId)
  if (existing) {
    if (existing.user_id !== daemon.user_id) return c.json({ error: 'conflict' }, 409)
    return c.json({ ok: true })
  }

  await createDevice(c.env.DB, {
    id: deviceId,
    userId: daemon.user_id,
    name,
    devicePubkey,
    now: Date.now(),
    boundSessionJti: boundJti,
  })
  return c.json({ ok: true })
})

// POST /pair/revoke — daemon-token-authed. Local Settings / `hive remote revoke` call this so the
// gateway row + session JWT die with the local SQLite revoke (they otherwise live up to 30 days).
pairRoutes.post('/revoke', async (c) => {
  const token = bearerToken(c.req.raw)
  if (token === null) return c.json({ error: 'unauthorized' }, 401)
  const daemon = await getLiveDaemonByToken(c.env.DB, token)
  if (!daemon) return c.json({ error: 'unauthorized' }, 401)

  const body = await readJson(c.req.raw)
  const deviceId = str(body, 'deviceId')
  if (!deviceId) return c.json({ error: 'missing_fields' }, 400)

  const ok = await revokeDevice(c.env.DB, {
    deviceId,
    userId: daemon.user_id,
    now: Date.now(),
    reason: 'daemon_revoke',
  })
  if (!ok) {
    // An owned, already-revoked device is an idempotent success. A missing
    // or foreign device is NOT an acknowledgement of another account's work.
    const device = await getDeviceById(c.env.DB, deviceId)
    if (!device || device.user_id !== daemon.user_id || device.revoked_at === null) {
      return c.json({ error: 'not_found' }, 404)
    }
  }

  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(daemon.user_id))
  c.executionCtx.waitUntil(stub.revoke('device', deviceId, 'device_revoke'))
  return c.json({ ok: true })
})

// POST /pair/session — unpaired-phone-session-authed. Exchanges the caller's unpaired (deviceId=null)
// session for a device-bound (`did`) one. The AUTHORITY is here, not the phone: we re-check the row
// exists, is confirmed (created by /pair/confirm), owned by the caller, not revoked, and that its
// bound_session_jti matches the caller's jti. mint+revoke order is revoke-old-first (HARDEN).
pairRoutes.post('/session', async (c) => {
  const claims = await sessionFromRequest(c.env, c.req.raw)
  if (claims === null) return c.json({ error: 'unauthorized' }, 401)
  // Only an UNPAIRED session may mint a device session. A did-session caller is already paired.
  if (claims.deviceId !== null) return c.json({ error: 'already_paired' }, 403)

  const body = await readJson(c.req.raw)
  const deviceId = str(body, 'deviceId')
  if (!deviceId) return c.json({ error: 'missing_deviceId' }, 400)

  const device = await getDeviceById(c.env.DB, deviceId)
  // No row (no /pair/confirm yet) / wrong account / revoked → 403. No mint.
  if (!device || device.user_id !== claims.userId || device.revoked_at !== null) {
    return c.json({ error: 'forbidden' }, 403)
  }
  // The bind closes the concurrent-session race AND is single-use: a successful mint nulls it, so a
  // replay (bound_session_jti === null) lands here and is rejected before re-minting.
  if (device.bound_session_jti === null || device.bound_session_jti !== claims.jti) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const now = Date.now()
  // Revoke the spent unpaired jti FIRST, then mint, then clear the bind. A partial failure leaves the
  // phone needing to re-auth (its unpaired session is dead) rather than holding two live sessions.
  await revokeSession(c.env.DB, { jti: claims.jti, userId: claims.userId, now, reason: 'paired' })
  const mint = await mintSession(c.env, {
    userId: claims.userId,
    deviceId,
    ttlMs: PHONE_SESSION_TTL_MS,
  })
  await clearDeviceBoundJti(c.env.DB, { deviceId, userId: claims.userId })

  c.header('Set-Cookie', sessionSetCookie(mint.token, PHONE_SESSION_TTL_MS))
  return c.json({ deviceId })
})

// POST /pair/relay-token — device-bound-session-authed. Hands the phone the RAW value of its own
// device session JWT so it can put it in `Sec-WebSocket-Protocol: bearer.<token>` on /relay. A browser
// WebSocket can't set Authorization and can't read the HttpOnly hive_gw_session cookie, and /relay
// forbids cookie auth (HARDEN §6.1) — so this endpoint is the only bridge from the cookie the phone
// already holds to the bearer the relay upgrade needs.
//
// SECURITY: this deliberately exposes the device-bound token to JS. That's an accepted, bounded leak,
// not a privilege gain: the token is the SAME credential already in the cookie (we re-read it raw and
// hand it back, we do NOT mint a new session — no jti proliferation), so it grants exactly the reach
// the device already has. The bundle that reads it is SRI-pinned (TOFU), the same trust boundary as
// Proton/WhatsApp Web. Gated on a PAIRED (did) session: an unpaired/absent session gets nothing.
pairRoutes.post('/relay-token', async (c) => {
  const claims = await sessionFromRequest(c.env, c.req.raw)
  // Must be a paired device session: claims present AND did set. An unpaired (deviceId=null) or absent
  // session has no business holding a /relay bearer — the data relay would 403 it anyway.
  if (claims === null || claims.deviceId === null) return c.json({ error: 'forbidden' }, 403)

  // Re-read the raw cookie value rather than re-minting. sessionFromRequest already verified this exact
  // token above, so a present-and-paired claims set guarantees the cookie carries a valid device JWT.
  const token = readSessionCookie(c.req.raw)
  if (token === null) return c.json({ error: 'forbidden' }, 403)

  return c.json({ token })
})

// GET /pair/machines — the JSON machine list the phone connect-flow reads. Account-isolated
// (getDaemonsForUser is user_id-scoped) + opaque (the DO reports only which of the caller's daemonIds
// are live). self.deviceId tells the UI whether THIS session is already paired. Logged-out → 401.
pairRoutes.get('/machines', async (c) => {
  const claims = await sessionFromRequest(c.env, c.req.raw)
  if (claims === null) return c.json({ error: 'unauthorized' }, 401)

  const daemons = await getDaemonsForUser(c.env.DB, claims.userId)
  // The caller's OWN DO only — never another account's. Reports just the live daemonIds.
  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(claims.userId))
  const live = new Set(await stub.liveDaemonIds())

  return c.json({
    daemons: daemons.map((d) => ({
      id: d.id,
      name: d.name,
      lastSeen: d.last_seen,
      revoked: d.revoked_at !== null,
      online: live.has(d.id),
    })),
    self: { deviceId: claims.deviceId },
  })
})
