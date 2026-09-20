import type { Database } from './sqlite.js'

export const applySchemaVersion32 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_uploads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      remote_device_id TEXT,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_uploads_workspace_created
      ON workspace_uploads (workspace_id, created_at DESC, id DESC);
  `)
}
