import type { Database } from './sqlite.js'

/** Per-dispatch collaboration cost: UTF-8 byte lengths of PTY envelopes. */
export const applySchemaVersion44 = (db: Database) => {
  const present = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!present.has('dispatch_payload_bytes')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN dispatch_payload_bytes INTEGER')
  }
  if (!present.has('report_payload_bytes')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN report_payload_bytes INTEGER')
  }
}
