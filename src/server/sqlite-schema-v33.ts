import type { Database } from './sqlite.js'

/** v33 retired: Sentinel was removed as a built-in role in v40. */
export const applySchemaVersion33 = (db: Database) => {
  db.prepare('SELECT 1').get()
}
