// D1 data-access layer for the gateway. Every SQL statement lives here behind a typed function;
// route/relay code never writes raw SQL. All statements use .bind() (no string interpolation).
//
// Row shape == migrations/0001_init.sql. *_at columns are epoch ms (numbers). Liveness is encoded
// as `revoked_at IS NULL` — a revoked credential keeps its row (audit) but the hot path rejects it.
//
// Token hashing: daemon tokens and one-time daemon codes are NEVER stored in cleartext. We store
// sha256Hex(secret); callers hand us the raw secret, we hash before it touches the DB. Lookups hash
// the presented secret and compare — the DB only ever holds the digest.

import type { Env, OAuthProvider, RevocationKind } from './env.js'

// ---------------------------------------------------------------------------
// Row types — exact column mirror. `| null` (not optional) because D1 returns null,
// and exactOptionalPropertyTypes makes the distinction load-bearing.
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string
  provider: OAuthProvider
  provider_sub: string
  email: string | null
  created_at: number
}

export interface DaemonRow {
  id: string
  user_id: string
  name: string
  daemon_token_hash: string
  created_at: number
  last_seen: number | null
  revoked_at: number | null
}

export interface DeviceRow {
  id: string
  user_id: string
  name: string
  device_pubkey: string
  created_at: number
  last_active: number | null
  revoked_at: number | null
  // The gateway-session jti the phone bound into its pairing Hello. Set at createDevice time (the
  // daemon's POST /pair/confirm), checked once by POST /pair/session, then nulled (single-use bind).
  bound_session_jti: string | null
}

export interface SessionRow {
  jti: string
  user_id: string
  device_id: string | null
  created_at: number
  expires_at: number
  revoked_at: number | null
}

export interface DaemonCodeRow {
  code_hash: string
  created_at: number
  expires_at: number
  user_id: string | null
  approved_at: number | null
  consumed_at: number | null
  daemon_id: string | null
}

// ---------------------------------------------------------------------------
// Hashing — Web Crypto (workerd). Hex SHA-256. Used for daemon tokens AND one-time codes.
// ---------------------------------------------------------------------------

export async function sha256Hex(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// ===========================================================================
// users
// ===========================================================================

// First login == signup. Idempotent on (provider, provider_sub): inserts on first sight,
// refreshes the informational email otherwise, and always returns the canonical row. `now` and
// `newId` are injected so the caller owns the clock + id source (testable, no hidden Date.now()).
export async function upsertUser(
  db: D1Database,
  input: {
    provider: OAuthProvider
    providerSub: string
    email: string | null
    now: number
    newId: string
  }
): Promise<UserRow> {
  await db
    .prepare(
      `INSERT INTO users (id, provider, provider_sub, email, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (provider, provider_sub)
       DO UPDATE SET email = excluded.email`
    )
    .bind(input.newId, input.provider, input.providerSub, input.email, input.now)
    .run()

  const row = await db
    .prepare('SELECT * FROM users WHERE provider = ?1 AND provider_sub = ?2')
    .bind(input.provider, input.providerSub)
    .first<UserRow>()
  if (!row) throw new Error('upsertUser: row missing after upsert')
  return row
}

export async function getUserById(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1').bind(userId).first<UserRow>()
}

// ===========================================================================
// daemons
// ===========================================================================

// Stores only the hash of `daemonToken`. Caller keeps the raw token to hand back to the daemon ONCE.
export async function createDaemon(
  db: D1Database,
  input: { id: string; userId: string; name: string; daemonToken: string; now: number }
): Promise<DaemonRow> {
  const hash = await sha256Hex(input.daemonToken)
  await db
    .prepare(
      `INSERT INTO daemons (id, user_id, name, daemon_token_hash, created_at, last_seen, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)`
    )
    .bind(input.id, input.userId, input.name, hash, input.now)
    .run()
  const row = await getDaemonById(db, input.id)
  if (!row) throw new Error('createDaemon: row missing after insert')
  return row
}

export async function getDaemonById(db: D1Database, daemonId: string): Promise<DaemonRow | null> {
  return db.prepare('SELECT * FROM daemons WHERE id = ?1').bind(daemonId).first<DaemonRow>()
}

// List for the device-management / machine-list UI. Newest first. Includes revoked rows (UI greys them).
export async function getDaemonsForUser(db: D1Database, userId: string): Promise<DaemonRow[]> {
  const res = await db
    .prepare('SELECT * FROM daemons WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all<DaemonRow>()
  return res.results
}

// Relay/daemon auth entry point. Resolves a presented raw token to its LIVE daemon row, or null.
// Returns null for unknown OR revoked tokens — the relay must not distinguish (no oracle).
export async function getLiveDaemonByToken(
  db: D1Database,
  daemonToken: string
): Promise<DaemonRow | null> {
  const hash = await sha256Hex(daemonToken)
  return db
    .prepare('SELECT * FROM daemons WHERE daemon_token_hash = ?1 AND revoked_at IS NULL')
    .bind(hash)
    .first<DaemonRow>()
}

export async function touchDaemonSeen(
  db: D1Database,
  daemonId: string,
  now: number
): Promise<void> {
  await db.prepare('UPDATE daemons SET last_seen = ?2 WHERE id = ?1').bind(daemonId, now).run()
}

// Revoke is scoped by user_id: you can only revoke a daemon you own (anti-IDOR at the query level).
// Returns true iff a live daemon owned by userId was actually revoked. Also writes the deny-list row.
export async function revokeDaemon(
  db: D1Database,
  input: { daemonId: string; userId: string; now: number; reason?: string }
): Promise<boolean> {
  const daemon = await db
    .prepare(
      'SELECT daemon_token_hash FROM daemons WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL'
    )
    .bind(input.daemonId, input.userId)
    .first<{ daemon_token_hash: string }>()
  if (!daemon) return false

  await db
    .prepare('UPDATE daemons SET revoked_at = ?2 WHERE id = ?1')
    .bind(input.daemonId, input.now)
    .run()
  await addRevocation(db, {
    id: daemon.daemon_token_hash,
    kind: 'daemon',
    userId: input.userId,
    now: input.now,
    reason: input.reason ?? 'daemon_revoke',
  })
  return true
}

// ===========================================================================
// devices  (rows created ONLY after desktop approval — see M4)
// ===========================================================================

// Created ONLY by the daemon's POST /pair/confirm, AFTER the desktop confirms (M4 trust root). The
// phone has no daemon token, so it can't reach that endpoint and can't self-promote. boundSessionJti
// records the unpaired gateway-session jti the phone bound into its pairing Hello; POST /pair/session
// requires it to match the caller's jti before minting a device session (concurrent-session race).
export async function createDevice(
  db: D1Database,
  input: {
    id: string
    userId: string
    name: string
    devicePubkey: string
    now: number
    boundSessionJti?: string | null
  }
): Promise<DeviceRow> {
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, device_pubkey, created_at, last_active, revoked_at, bound_session_jti)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6)`
    )
    .bind(
      input.id,
      input.userId,
      input.name,
      input.devicePubkey,
      input.now,
      input.boundSessionJti ?? null
    )
    .run()
  const row = await getDeviceById(db, input.id)
  if (!row) throw new Error('createDevice: row missing after insert')
  return row
}

// Clear the one-time pairing bind after a successful /pair/session mint. Scoped by user_id so a
// device row can only be cleared by its owner. Single-use: a replay of /pair/session for the same
// device finds bound_session_jti === NULL and is rejected before re-minting.
export async function clearDeviceBoundJti(
  db: D1Database,
  input: { deviceId: string; userId: string }
): Promise<void> {
  await db
    .prepare('UPDATE devices SET bound_session_jti = NULL WHERE id = ?1 AND user_id = ?2')
    .bind(input.deviceId, input.userId)
    .run()
}

export async function getDeviceById(db: D1Database, deviceId: string): Promise<DeviceRow | null> {
  return db.prepare('SELECT * FROM devices WHERE id = ?1').bind(deviceId).first<DeviceRow>()
}

export async function getDevicesForUser(db: D1Database, userId: string): Promise<DeviceRow[]> {
  const res = await db
    .prepare('SELECT * FROM devices WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all<DeviceRow>()
  return res.results
}

export async function touchDeviceActive(
  db: D1Database,
  deviceId: string,
  now: number
): Promise<void> {
  await db.prepare('UPDATE devices SET last_active = ?2 WHERE id = ?1').bind(deviceId, now).run()
}

// Revoke a device AND all its still-live sessions in one go. Scoped by user_id (anti-IDOR).
// A phone may revoke any of its account's devices incl. itself (Parity Matrix) — that's enforced by
// passing the caller's own userId here; cross-account revoke is impossible because the WHERE pins it.
export async function revokeDevice(
  db: D1Database,
  input: { deviceId: string; userId: string; now: number; reason?: string }
): Promise<boolean> {
  const device = await db
    .prepare('SELECT id FROM devices WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL')
    .bind(input.deviceId, input.userId)
    .first<{ id: string }>()
  if (!device) return false

  await db
    .prepare('UPDATE devices SET revoked_at = ?2 WHERE id = ?1')
    .bind(input.deviceId, input.now)
    .run()
  await addRevocation(db, {
    id: input.deviceId,
    kind: 'device',
    userId: input.userId,
    now: input.now,
    reason: input.reason ?? 'device_revoke',
  })

  // Cascade: kill every live session bound to this device.
  const live = await db
    .prepare('SELECT jti FROM sessions WHERE device_id = ?1 AND revoked_at IS NULL')
    .bind(input.deviceId)
    .all<{ jti: string }>()
  for (const s of live.results) {
    await revokeSession(db, {
      jti: s.jti,
      userId: input.userId,
      now: input.now,
      reason: 'device_revoke',
    })
  }
  return true
}

// ===========================================================================
// sessions  (keyed by jti; the JWT 'jti' claim)
// ===========================================================================

export async function createSession(
  db: D1Database,
  input: {
    jti: string
    userId: string
    deviceId: string | null
    createdAt: number
    expiresAt: number
  }
): Promise<SessionRow> {
  await db
    .prepare(
      `INSERT INTO sessions (jti, user_id, device_id, created_at, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`
    )
    .bind(input.jti, input.userId, input.deviceId, input.createdAt, input.expiresAt)
    .run()
  const row = await db
    .prepare('SELECT * FROM sessions WHERE jti = ?1')
    .bind(input.jti)
    .first<SessionRow>()
  if (!row) throw new Error('createSession: row missing after insert')
  return row
}

export async function revokeSession(
  db: D1Database,
  input: { jti: string; userId: string; now: number; reason?: string }
): Promise<boolean> {
  const sess = await db
    .prepare('SELECT jti FROM sessions WHERE jti = ?1 AND user_id = ?2 AND revoked_at IS NULL')
    .bind(input.jti, input.userId)
    .first<{ jti: string }>()
  if (!sess) return false

  await db
    .prepare('UPDATE sessions SET revoked_at = ?2 WHERE jti = ?1')
    .bind(input.jti, input.now)
    .run()
  await addRevocation(db, {
    id: input.jti,
    kind: 'session',
    userId: input.userId,
    now: input.now,
    reason: input.reason ?? 'logout',
  })
  return true
}

// ===========================================================================
// revocations  (the hot-path deny-list — consulted on every JWT verify + relay connect)
// ===========================================================================

// Idempotent: re-revoking is a no-op (the original revoked_at/reason wins).
export async function addRevocation(
  db: D1Database,
  input: { id: string; kind: RevocationKind; userId: string; now: number; reason?: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO revocations (id, kind, user_id, revoked_at, reason)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (kind, id) DO NOTHING`
    )
    .bind(input.id, input.kind, input.userId, input.now, input.reason ?? null)
    .run()
}

// Single hot-path lookup the JWT-verify and relay-auth code calls. True == this credential is dead.
//   - session: id = jti
//   - daemon:  id = daemon_token_hash (NOT the daemon id)
//   - device:  id = device id
export async function isRevoked(
  db: D1Database,
  kind: RevocationKind,
  id: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM revocations WHERE kind = ?1 AND id = ?2')
    .bind(kind, id)
    .first<{ hit: number }>()
  return row !== null
}

// ===========================================================================
// daemon_codes  (security invariant #5 — short-TTL one-time binding code)
// ===========================================================================

// Step 1: daemon asks for a code. We store only its hash + a TTL. No user yet.
export async function createDaemonCode(
  db: D1Database,
  input: { code: string; createdAt: number; expiresAt: number }
): Promise<void> {
  const hash = await sha256Hex(input.code)
  await db
    .prepare(
      `INSERT INTO daemon_codes (code_hash, created_at, expires_at, user_id, approved_at, consumed_at, daemon_id)
       VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL)`
    )
    .bind(hash, input.createdAt, input.expiresAt)
    .run()
}

// Step 2: a logged-in browser approves the code, binding it to the user. Only succeeds for an
// unexpired, unconsumed, not-yet-approved code. `now` checked against expires_at server-side.
export async function approveDaemonCode(
  db: D1Database,
  input: { code: string; userId: string; now: number }
): Promise<boolean> {
  const hash = await sha256Hex(input.code)
  const res = await db
    .prepare(
      `UPDATE daemon_codes SET user_id = ?2, approved_at = ?3
       WHERE code_hash = ?1
         AND approved_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > ?3`
    )
    .bind(hash, input.userId, input.now)
    .run()
  return res.meta.changes === 1
}

// Step 3: daemon exchanges the code for a token. Atomic single-use: the UPDATE both checks
// "approved && unconsumed && unexpired" and stamps consumed_at, so a replay finds nothing.
// Returns the bound user_id on success (caller then createDaemon + back-links daemon_id), else null.
export async function consumeApprovedDaemonCode(
  db: D1Database,
  input: { code: string; now: number }
): Promise<{ userId: string } | null> {
  const hash = await sha256Hex(input.code)
  const res = await db
    .prepare(
      `UPDATE daemon_codes SET consumed_at = ?2
       WHERE code_hash = ?1
         AND approved_at IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at > ?2
       RETURNING user_id`
    )
    .bind(hash, input.now)
    .first<{ user_id: string | null }>()
  if (!res || res.user_id === null) return null
  return { userId: res.user_id }
}

// Back-link the daemon created at exchange time onto the consumed code (audit trail).
export async function linkDaemonCode(
  db: D1Database,
  code: string,
  daemonId: string
): Promise<void> {
  const hash = await sha256Hex(code)
  await db
    .prepare('UPDATE daemon_codes SET daemon_id = ?2 WHERE code_hash = ?1')
    .bind(hash, daemonId)
    .run()
}

// Convenience for the relay-auth path: resolve a live daemon token straight to its env-typed DB.
// Thin wrapper so relay code depends on Env, not D1Database, matching the rest of the worker.
export function db(env: Env): D1Database {
  return env.DB
}
