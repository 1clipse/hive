import { env } from 'cloudflare:test'
import { beforeEach, expect, test } from 'vitest'
import {
  addRevocation,
  approveDaemonCode,
  consumeApprovedDaemonCode,
  createDaemon,
  createDaemonCode,
  createDevice,
  createSession,
  getDaemonsForUser,
  getLiveDaemonByToken,
  isRevoked,
  revokeDaemon,
  revokeDevice,
  revokeSession,
  sha256Hex,
  upsertUser,
} from '../src/db.js'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
  }
}

const DB = () => env.DB

// Each test starts from a clean slate so asserts are about THIS test's writes, not leftovers.
beforeEach(async () => {
  await DB().exec('DELETE FROM revocations')
  await DB().exec('DELETE FROM daemon_codes')
  await DB().exec('DELETE FROM sessions')
  await DB().exec('DELETE FROM devices')
  await DB().exec('DELETE FROM daemons')
  await DB().exec('DELETE FROM users')
})

// --- users: first login == signup, idempotent on (provider, provider_sub) -------------------

test('upsertUser inserts once and is idempotent on (provider, provider_sub)', async () => {
  const a = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'gh-42',
    email: 'a@x.com',
    now: 1000,
    newId: 'user-a',
  })
  // Same subject, different injected id + email -> MUST resolve to the original row, not a 2nd user.
  const b = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'gh-42',
    email: 'a-new@x.com',
    now: 2000,
    newId: 'user-DIFFERENT',
  })
  expect(b.id).toBe(a.id)
  expect(b.id).toBe('user-a')
  expect(b.created_at).toBe(1000) // created_at preserved, not overwritten by the 2nd login
  expect(b.email).toBe('a-new@x.com') // email refreshed

  const count = await DB().prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  expect(count?.n).toBe(1)
})

test('same provider_sub under a different provider is a DIFFERENT account', async () => {
  await upsertUser(DB(), {
    provider: 'github',
    providerSub: '777',
    email: null,
    now: 1,
    newId: 'u-gh',
  })
  await upsertUser(DB(), {
    provider: 'google',
    providerSub: '777',
    email: null,
    now: 2,
    newId: 'u-goog',
  })
  const count = await DB().prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  expect(count?.n).toBe(2)
})

// --- daemon tokens: stored only as a hash; revoked tokens never resolve --------------------

test('daemon token is stored ONLY as a hash, never cleartext', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'g1',
    email: null,
    now: 1,
    newId: 'u1',
  })
  const token = 'super-secret-daemon-token'
  await createDaemon(DB(), {
    id: 'd1',
    userId: user.id,
    name: 'laptop',
    daemonToken: token,
    now: 10,
  })

  const stored = await DB()
    .prepare('SELECT daemon_token_hash FROM daemons WHERE id = ?1')
    .bind('d1')
    .first<{
      daemon_token_hash: string
    }>()
  expect(stored?.daemon_token_hash).toBe(await sha256Hex(token))
  expect(stored?.daemon_token_hash).not.toBe(token) // would pass trivially only if we stored cleartext — we don't
})

test('getLiveDaemonByToken resolves a live token and refuses a revoked one with no oracle', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'g2',
    email: null,
    now: 1,
    newId: 'u2',
  })
  const token = 'tok-live'
  await createDaemon(DB(), { id: 'd2', userId: user.id, name: 'm', daemonToken: token, now: 10 })

  const live = await getLiveDaemonByToken(DB(), token)
  expect(live?.id).toBe('d2')

  // Wrong token -> null (not the row).
  expect(await getLiveDaemonByToken(DB(), 'wrong-token')).toBeNull()

  // After revoke, the SAME valid token must return null (revoked_at filter), not the row.
  const did = await revokeDaemon(DB(), { daemonId: 'd2', userId: user.id, now: 20 })
  expect(did).toBe(true)
  expect(await getLiveDaemonByToken(DB(), token)).toBeNull()
})

// --- anti-IDOR: ownership-scoped mutations cannot cross accounts ----------------------------

test("revokeDaemon cannot revoke another account's daemon (IDOR)", async () => {
  const owner = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'o',
    email: null,
    now: 1,
    newId: 'owner',
  })
  const attacker = await upsertUser(DB(), {
    provider: 'google',
    providerSub: 'a',
    email: null,
    now: 1,
    newId: 'atk',
  })
  await createDaemon(DB(), {
    id: 'victim-d',
    userId: owner.id,
    name: 'm',
    daemonToken: 't',
    now: 10,
  })

  // Attacker presents the real daemonId but their own userId -> must be a no-op.
  const did = await revokeDaemon(DB(), { daemonId: 'victim-d', userId: attacker.id, now: 50 })
  expect(did).toBe(false)

  // The victim daemon is still LIVE.
  expect(await getLiveDaemonByToken(DB(), 't')).not.toBeNull()
  // And no bogus revocation row was written for the attacker.
  expect(await isRevoked(DB(), 'daemon', await sha256Hex('t'))).toBe(false)
})

test("getDaemonsForUser only returns the caller's own daemons", async () => {
  const ua = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'a',
    email: null,
    now: 1,
    newId: 'ua',
  })
  const ub = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'b',
    email: null,
    now: 1,
    newId: 'ub',
  })
  await createDaemon(DB(), { id: 'a1', userId: ua.id, name: 'x', daemonToken: 'ta', now: 5 })
  await createDaemon(DB(), { id: 'b1', userId: ub.id, name: 'y', daemonToken: 'tb', now: 6 })

  const aDaemons = await getDaemonsForUser(DB(), ua.id)
  expect(aDaemons.map((d) => d.id)).toEqual(['a1'])
  expect(aDaemons.some((d) => d.id === 'b1')).toBe(false)
})

// --- device revoke cascades to its sessions, scoped to owner ------------------------------

test('revokeDevice marks the device revoked AND cascades its live sessions', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'd',
    email: null,
    now: 1,
    newId: 'ud',
  })
  await createDevice(DB(), {
    id: 'dev1',
    userId: user.id,
    name: 'Pixel',
    devicePubkey: 'pk',
    now: 10,
  })
  await createSession(DB(), {
    jti: 'j1',
    userId: user.id,
    deviceId: 'dev1',
    createdAt: 11,
    expiresAt: 9_999_999,
  })
  await createSession(DB(), {
    jti: 'j2',
    userId: user.id,
    deviceId: 'dev1',
    createdAt: 12,
    expiresAt: 9_999_999,
  })
  // A session on a DIFFERENT device must be untouched.
  await createDevice(DB(), {
    id: 'dev2',
    userId: user.id,
    name: 'iPad',
    devicePubkey: 'pk2',
    now: 13,
  })
  await createSession(DB(), {
    jti: 'j3',
    userId: user.id,
    deviceId: 'dev2',
    createdAt: 14,
    expiresAt: 9_999_999,
  })

  const did = await revokeDevice(DB(), { deviceId: 'dev1', userId: user.id, now: 100 })
  expect(did).toBe(true)

  expect(await isRevoked(DB(), 'device', 'dev1')).toBe(true)
  expect(await isRevoked(DB(), 'session', 'j1')).toBe(true)
  expect(await isRevoked(DB(), 'session', 'j2')).toBe(true)
  // Untouched device's session is still live.
  expect(await isRevoked(DB(), 'session', 'j3')).toBe(false)
})

test("revokeDevice cannot touch another account's device (IDOR)", async () => {
  const owner = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'o2',
    email: null,
    now: 1,
    newId: 'o2',
  })
  const atk = await upsertUser(DB(), {
    provider: 'google',
    providerSub: 'a2',
    email: null,
    now: 1,
    newId: 'a2',
  })
  await createDevice(DB(), { id: 'vd', userId: owner.id, name: 'p', devicePubkey: 'pk', now: 10 })

  expect(await revokeDevice(DB(), { deviceId: 'vd', userId: atk.id, now: 50 })).toBe(false)
  expect(await isRevoked(DB(), 'device', 'vd')).toBe(false)
})

// --- revocations hot path -------------------------------------------------------------------

test('isRevoked distinguishes kinds in a shared id space', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'r',
    email: null,
    now: 1,
    newId: 'ur',
  })
  // Same literal id, different kind — must not collide.
  await addRevocation(DB(), { id: 'shared-id', kind: 'session', userId: user.id, now: 5 })
  expect(await isRevoked(DB(), 'session', 'shared-id')).toBe(true)
  expect(await isRevoked(DB(), 'device', 'shared-id')).toBe(false)
  expect(await isRevoked(DB(), 'daemon', 'shared-id')).toBe(false)
})

test('addRevocation is idempotent and revokeSession is owner-scoped', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 's',
    email: null,
    now: 1,
    newId: 'us',
  })
  const other = await upsertUser(DB(), {
    provider: 'google',
    providerSub: 's2',
    email: null,
    now: 1,
    newId: 'us2',
  })
  await createDevice(DB(), { id: 'dx', userId: user.id, name: 'p', devicePubkey: 'pk', now: 9 })
  await createSession(DB(), {
    jti: 'jx',
    userId: user.id,
    deviceId: 'dx',
    createdAt: 10,
    expiresAt: 9_999_999,
  })

  // Wrong owner cannot revoke the session.
  expect(await revokeSession(DB(), { jti: 'jx', userId: other.id, now: 20 })).toBe(false)
  expect(await isRevoked(DB(), 'session', 'jx')).toBe(false)

  // Right owner can; second revoke is a harmless no-op (already revoked).
  expect(await revokeSession(DB(), { jti: 'jx', userId: user.id, now: 21 })).toBe(true)
  expect(await revokeSession(DB(), { jti: 'jx', userId: user.id, now: 22 })).toBe(false)
  const n = await DB()
    .prepare("SELECT COUNT(*) AS n FROM revocations WHERE kind='session' AND id='jx'")
    .first<{
      n: number
    }>()
  expect(n?.n).toBe(1) // not duplicated
})

// --- daemon binding code: one-time, requires approval, TTL ----------------------------------

test('unapproved daemon code cannot be exchanged for a token', async () => {
  await createDaemonCode(DB(), { code: 'CODE1', createdAt: 1, expiresAt: 9_999_999 })
  // Never approved in a browser -> consume must yield nothing.
  expect(await consumeApprovedDaemonCode(DB(), { code: 'CODE1', now: 100 })).toBeNull()
})

test('approved daemon code is single-use: a replay yields nothing', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'c',
    email: null,
    now: 1,
    newId: 'uc',
  })
  await createDaemonCode(DB(), { code: 'CODE2', createdAt: 1, expiresAt: 9_999_999 })

  expect(await approveDaemonCode(DB(), { code: 'CODE2', userId: user.id, now: 10 })).toBe(true)

  const first = await consumeApprovedDaemonCode(DB(), { code: 'CODE2', now: 20 })
  expect(first?.userId).toBe(user.id)

  // Replay of the same code -> null (consumed_at already set).
  expect(await consumeApprovedDaemonCode(DB(), { code: 'CODE2', now: 21 })).toBeNull()
})

test('expired daemon code cannot be approved or consumed', async () => {
  const user = await upsertUser(DB(), {
    provider: 'github',
    providerSub: 'e',
    email: null,
    now: 1,
    newId: 'ue',
  })
  await createDaemonCode(DB(), { code: 'CODE3', createdAt: 1, expiresAt: 50 })

  // now (100) is past expires_at (50): approval must fail.
  expect(await approveDaemonCode(DB(), { code: 'CODE3', userId: user.id, now: 100 })).toBe(false)

  // Even if it had been approved within TTL, a later expiry blocks consume.
  await createDaemonCode(DB(), { code: 'CODE4', createdAt: 1, expiresAt: 50 })
  expect(await approveDaemonCode(DB(), { code: 'CODE4', userId: user.id, now: 10 })).toBe(true)
  expect(await consumeApprovedDaemonCode(DB(), { code: 'CODE4', now: 100 })).toBeNull()
})

test('daemon code is stored only as a hash', async () => {
  await createDaemonCode(DB(), { code: 'PLAINTEXT-CODE', createdAt: 1, expiresAt: 9_999_999 })
  const row = await DB()
    .prepare('SELECT code_hash FROM daemon_codes LIMIT 1')
    .first<{ code_hash: string }>()
  expect(row?.code_hash).toBe(await sha256Hex('PLAINTEXT-CODE'))
  expect(row?.code_hash).not.toContain('PLAINTEXT')
})
