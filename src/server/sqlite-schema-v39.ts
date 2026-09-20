import type { Database } from './sqlite.js'

export const applySchemaVersion39 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!workerColumns.has('avatar')) {
    db.exec('ALTER TABLE workers ADD COLUMN avatar TEXT')
  }
}
