import type { Database } from './sqlite.js'

export const applySchemaVersion28 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      input_seq_from INTEGER,
      input_seq_to INTEGER,
      report TEXT,
      revert_blob TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_runs_ws
      ON dream_runs(workspace_id, started_at);
  `)
}
