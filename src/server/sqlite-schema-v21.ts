import type { Database } from './sqlite.js'

export const applySchemaVersion21 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      script_path TEXT NOT NULL,
      cron TEXT NOT NULL,
      args TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due
      ON workflow_schedules (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_schedules_workspace
      ON workflow_schedules (workspace_id, created_at);
  `)
}
