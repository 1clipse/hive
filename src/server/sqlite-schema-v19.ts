import type { Database } from './sqlite.js'

export const applySchemaVersion19 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map((c) => c.name)
  )
  if (!workerColumns.has('ephemeral')) {
    db.exec('ALTER TABLE workers ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0')
  }
  if (!workerColumns.has('spawned_by')) {
    db.exec('ALTER TABLE workers ADD COLUMN spawned_by TEXT')
  }

  const dispatchColumns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  if (!dispatchColumns.has('workflow_run_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN workflow_run_id TEXT')
  }
  if (!dispatchColumns.has('step_index')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN step_index INTEGER')
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dispatches_workflow ON dispatches (workflow_run_id, step_index)'
  )
}
