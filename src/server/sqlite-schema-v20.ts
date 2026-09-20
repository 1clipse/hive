import type { Database } from './sqlite.js'

export const applySchemaVersion20 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      script_path TEXT NOT NULL,
      script_hash TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      args TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace
      ON workflow_runs (workspace_id, created_at);
  `)
}
