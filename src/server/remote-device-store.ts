import { fromBase64Url, toBase64Url } from '../shared/remote-crypto.js'
import type { DeviceSession, DeviceSessionProvider } from './remote-device-session.js'
import type { Database } from './sqlite.js'

// Persistent store for paired remote devices (schema v24). A row is written ONLY by
// remote-pairing.confirmPairing on a human desktop confirm (Authority Model trust root); nothing else
// in the runtime inserts here.
//
// M6.1: the key_d2p / key_p2d columns hold ROOT key material — byte-identical at rest to before, no
// schema change, no version bump. The bridge derives the per-connection AEAD keys from these roots +
// the bilateral connection salts (deriveConnectionKeys), never sealing/opening under the stored bytes
// directly. v24 rows are forward-compatible: their stored material IS the root.
//
// Two read paths with very different audiences:
//   - getLiveSession / liveSessions return the directional SESSION KEYS. They back the
//     DeviceSessionProvider the tunnel/bridge resolve a device through, so they are INTERNAL — no
//     route ever reaches them. Revoked rows are excluded (invariant 5, persistent half).
//   - list / get return RemoteDeviceRecord, metadata ONLY, no key material (invariant 7). These back
//     the device-management API.

// Metadata view for the device-management API. NEVER includes key material (invariant 7).
export interface RemoteDeviceRecord {
  id: string
  name: string
  createdAt: number
  lastActive: number | null
  revokedAt: number | null
}

export interface PersistDeviceInput {
  id: string
  name: string
  /** The M3 DeviceSession.keys — a stored secret. */
  keys: { d2p: Uint8Array; p2d: Uint8Array }
  devicePublicKey: Uint8Array
}

export interface RemoteDeviceStore {
  /** TRUST-ROOT write. ONLY remote-pairing.confirmPairing calls this, ONLY on desktop confirm. */
  insert(input: PersistDeviceInput, now?: number): RemoteDeviceRecord
  /** Provider read path (returns key material). null if absent OR revoked. INTERNAL. */
  getLiveSession(deviceId: string): DeviceSession | null
  /** Active (non-revoked) sessions only — backs DeviceSessionProvider.candidates(). */
  liveSessions(): DeviceSession[]
  /** Device-management read path — metadata ONLY, no keys. Newest first. */
  list(includeRevoked?: boolean): RemoteDeviceRecord[]
  get(deviceId: string): RemoteDeviceRecord | null
  /** Local half of the revocation closed loop. Idempotent; false if unknown / already revoked. */
  revoke(deviceId: string, now?: number): boolean
  /** Best-effort last_active bump. Never resurrects a revoked row. */
  touchActive(deviceId: string, now?: number): void
}

interface SessionRow {
  id: string
  key_d2p: string
  key_p2d: string
}

interface MetaRow {
  id: string
  name: string
  created_at: number
  last_active: number | null
  revoked_at: number | null
}

const toRecord = (row: MetaRow): RemoteDeviceRecord => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastActive: row.last_active,
  revokedAt: row.revoked_at,
})

const toSession = (row: SessionRow): DeviceSession => ({
  deviceId: row.id,
  keys: { d2p: fromBase64Url(row.key_d2p), p2d: fromBase64Url(row.key_p2d) },
})

export const createRemoteDeviceStore = (db: Database): RemoteDeviceStore => {
  const insertStmt = db.prepare(
    `INSERT INTO remote_devices
       (id, name, key_d2p, key_p2d, device_pubkey, created_at, last_active, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
  )
  // Note: the SELECT projections for the metadata path deliberately OMIT key_d2p/key_p2d/device_pubkey
  // so key material can never escape through list()/get() (invariant 7).
  const getMetaStmt = db.prepare(
    `SELECT id, name, created_at, last_active, revoked_at FROM remote_devices WHERE id = ?`
  )
  const listStmt = db.prepare(
    `SELECT id, name, created_at, last_active, revoked_at
       FROM remote_devices
      ORDER BY created_at DESC, id DESC`
  )
  const listActiveStmt = db.prepare(
    `SELECT id, name, created_at, last_active, revoked_at
       FROM remote_devices
      WHERE revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`
  )
  const liveSessionStmt = db.prepare(
    `SELECT id, key_d2p, key_p2d FROM remote_devices WHERE id = ? AND revoked_at IS NULL`
  )
  const liveSessionsStmt = db.prepare(
    `SELECT id, key_d2p, key_p2d FROM remote_devices WHERE revoked_at IS NULL`
  )
  // revoke only flips a row that is not already revoked, so a second call changes 0 rows -> false,
  // and the original revoked_at timestamp is never overwritten.
  const revokeStmt = db.prepare(
    `UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  )
  const touchStmt = db.prepare(
    `UPDATE remote_devices SET last_active = ? WHERE id = ? AND revoked_at IS NULL`
  )

  return {
    insert(input, now = Date.now()) {
      insertStmt.run(
        input.id,
        input.name,
        toBase64Url(input.keys.d2p),
        toBase64Url(input.keys.p2d),
        toBase64Url(input.devicePublicKey),
        now
      )
      return { id: input.id, name: input.name, createdAt: now, lastActive: null, revokedAt: null }
    },

    getLiveSession(deviceId) {
      const row = liveSessionStmt.get(deviceId) as SessionRow | undefined
      return row ? toSession(row) : null
    },

    liveSessions() {
      return (liveSessionsStmt.all() as SessionRow[]).map(toSession)
    },

    list(includeRevoked = false) {
      const rows = (includeRevoked ? listStmt : listActiveStmt).all() as MetaRow[]
      return rows.map(toRecord)
    },

    get(deviceId) {
      const row = getMetaStmt.get(deviceId) as MetaRow | undefined
      return row ? toRecord(row) : null
    },

    revoke(deviceId, now = Date.now()) {
      return revokeStmt.run(now, deviceId).changes > 0
    },

    touchActive(deviceId, now = Date.now()) {
      touchStmt.run(now, deviceId)
    },
  }
}

// Persistent DeviceSessionProvider — no cache. get()/candidates() read the store live, so a revoke()
// write makes the next inbound frame fail in the M3 bridge (resolveAndOpen -> get null / candidate
// gone -> drop + audit 'no_session'). Zero bridge change for the persistence half (invariant 5).
export const createPersistentDeviceSessionProvider = (
  store: RemoteDeviceStore
): DeviceSessionProvider => ({
  get: (deviceId) => store.getLiveSession(deviceId),
  candidates: () => store.liveSessions(),
})
