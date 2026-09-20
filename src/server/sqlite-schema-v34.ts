import type { Database } from './sqlite.js'

/**
 * v34: local retention signals (issue #23) — per-day protocol event counters.
 *
 * Deliberately a dedicated append-only counter table instead of aggregating
 * `messages` / `dispatches` at read time: both of those are pruned when
 * workers or workspaces are deleted (ephemeral workers especially), so
 * historical activity would silently shrink. Counters are local-only —
 * nothing here is ever transmitted anywhere.
 */
export const applySchemaVersion34 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS protocol_event_daily (
      day TEXT NOT NULL,
      event TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, event)
    );
  `)
}
