import type { Database } from './sqlite.js'

// v24 — paired remote devices. A row exists ONLY after a human confirmed the pairing at the desktop
// (Authority Model trust root): the pending handshake lives in memory in remote-pairing.ts and is
// INSERTed here on confirm, NEVER before.
//
// key_d2p/key_p2d are the M3 DeviceSession.keys — M6.1 reinterprets these as the directional ROOT keys:
// the bridge derives a fresh per-connection AEAD key from them on every connect (deriveConnectionKeys)
// and never seals/opens under the stored bytes directly. The at-rest format is byte-identical — no
// schema change, no version bump; v24 rows are forward-compatible (their stored material IS the root).
// They are a stored secret in the sense that they decrypt all of that device's E2E traffic, but the
// protection here is
// exactly the same filesystem-local posture as remote_daemon_token (plaintext in app_state, see
// remote-config-keys.ts): the runtime.sqlite file lives next to the daemon on 127.0.0.1. This is NOT
// encryption-at-rest. If at-rest encryption is later wanted it should cover daemon_token + these keys
// together as a single hardening item, not be implied here.
//
// revoked_at != NULL = dead device: the persistent provider returns null for it at once (live streams
// drop on the next frame). Rows are kept (soft tombstone) so the device list / audit can still show a
// revoked device.
export const applySchemaVersion24 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_devices (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      key_d2p       TEXT NOT NULL,   -- base64url(32) daemon->phone (daemon SEALS)
      key_p2d       TEXT NOT NULL,   -- base64url(32) phone->daemon (daemon OPENS)
      device_pubkey TEXT NOT NULL,   -- base64url(32); audit/debug, not secret
      created_at    INTEGER NOT NULL,
      last_active   INTEGER,
      revoked_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_remote_devices_active
      ON remote_devices (revoked_at, created_at DESC);
  `)
}
