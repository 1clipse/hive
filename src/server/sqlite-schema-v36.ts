import type { Database } from './sqlite.js'

const ensureColumn = (db: Database, table: string, column: string, definition: string) => {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  )
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/** v36: structured memory procedure/workflow references. */
export const applySchemaVersion36 = (db: Database) => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'")
    .get()
  if (!table) return

  ensureColumn(db, 'memory_entries', 'ref_type', 'TEXT')
  ensureColumn(db, 'memory_entries', 'ref_id', 'TEXT')
  ensureColumn(db, 'memory_entries', 'ref_title', 'TEXT')
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_ref
      ON memory_entries(ref_type, ref_id)
      WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL;
  `)
}
