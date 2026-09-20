import type { Database } from './sqlite.js'

// v23 — remote-access (mobile) audit trail. The tunnel/bridge layer is the
// SINGLE collection point for every remote HTTP request + WS-input event
// (see the plan's 审计规格): one place to record so no per-route handler has
// to know about remote at all. Rows are append-only and written async off the
// forwarding path (remote-audit-store.ts), so a slow disk never stalls a frame.
//
// Schema notes:
//   - remote_device_id is the M1 session's device id; it's an audit/revocation
//     tag, NEVER a permission branch (Authority Model: paired device == local).
//   - action is a coarse category, not a full URL ('http' for bridged API
//     requests, 'ws_input' for terminal/tasks stdin, plus lifecycle/control
//     actions like 'session_open' / 'revoke' / 'reject'). endpoint holds the
//     whitelisted path ('/api/...' '/ws/...') when there is one.
//   - result is 'ok' | 'rejected' | 'error'. reject_reason is set ONLY on a
//     rejection (off-whitelist path, revoked device, forged secret, …) so the
//     security tests can assert the reason text, not just that a row exists.
//   - WS input is summarised: byte_count + a short truncated preview. We NEVER
//     persist full stdin (that's the user typing into a YOLO terminal). The
//     preview is bounded by the store before it reaches here.
//
// Index covers the Settings audit-stream view: newest-first, optionally scoped
// to one device.
export const applySchemaVersion23 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      remote_device_id TEXT,
      ts INTEGER NOT NULL,
      workspace_id TEXT,
      action TEXT NOT NULL,
      endpoint TEXT,
      result TEXT NOT NULL,
      reject_reason TEXT,
      byte_count INTEGER,
      preview TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_remote_audit_recent
      ON remote_audit (id DESC);
    CREATE INDEX IF NOT EXISTS idx_remote_audit_device
      ON remote_audit (remote_device_id, id DESC);
  `)
}
