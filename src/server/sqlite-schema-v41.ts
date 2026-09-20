import type { Database } from './sqlite.js'

/** One local Codex App controller per workspace; durable notification and operation receipts. */
export const applySchemaVersion41 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_controllers (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      thread_id TEXT,
      request_id TEXT,
      request_thread_id TEXT,
      connection_error TEXT
    );
  `)
  // Shared data directories can contain foreign version stamps. Reconcile the
  // owned columns at the migration boundary rather than assuming version == shape.
  const columns: Array<[string, string, string]> = [
    [
      'workspaces',
      'controller_mode',
      "TEXT NOT NULL DEFAULT 'internal' CHECK(controller_mode IN ('internal', 'codex_app'))",
    ],
    ['report_outbox', 'notification_state', "TEXT NOT NULL DEFAULT 'pending'"],
    ['report_outbox', 'notification_error', 'TEXT'],
    ['report_outbox', 'read_at', 'INTEGER'],
    ['report_outbox', 'event_kind', "TEXT NOT NULL DEFAULT 'dispatch_result'"],
    ['report_outbox', 'source_dispatch_id', 'TEXT'],
    ['workspace_controllers', 'connection_error', 'TEXT'],
  ]
  for (const [table, column, definition] of columns) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!present.some((item) => item.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_report_outbox_notification ON report_outbox(notification_state, delivered_at, read_at, id);
    CREATE TRIGGER IF NOT EXISTS controller_dispatch_terminal AFTER UPDATE OF status ON dispatches
      WHEN NEW.status IN ('reported', 'cancelled') AND OLD.status NOT IN ('reported', 'cancelled')
        AND NEW.from_agent_id = NEW.workspace_id || ':orchestrator' AND NEW.workflow_run_id IS NULL
        AND EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND controller_mode = 'codex_app')
      BEGIN
        INSERT OR IGNORE INTO report_outbox(workspace_id,target_agent_id,dispatch_id,payload,created_at)
        VALUES(NEW.workspace_id,NEW.from_agent_id,NEW.id,COALESCE(NEW.report_text,''),NEW.reported_at);
      END;
    CREATE TRIGGER IF NOT EXISTS controller_member_exit AFTER UPDATE OF status ON agent_runs
      WHEN NEW.status IN ('exited','error') AND OLD.status IN ('starting','running')
      BEGIN
        INSERT OR IGNORE INTO report_outbox(workspace_id,target_agent_id,dispatch_id,payload,created_at,event_kind,source_dispatch_id)
        SELECT d.workspace_id, d.from_agent_id, 'exit:' || NEW.run_id || ':' || d.id,
          'Member process exited before reporting. The dispatch remains open; inspect the member and explicitly restart or cancel it.',
          COALESCE(NEW.ended_at,NEW.updated_at), 'member_exit', d.id
        FROM dispatches d JOIN workspaces w ON w.id = d.workspace_id
        WHERE d.to_agent_id = NEW.agent_id AND d.status IN ('queued','submitted')
          AND d.workflow_run_id IS NULL AND d.from_agent_id = d.workspace_id || ':orchestrator'
          AND w.controller_mode = 'codex_app';
      END;
    CREATE TABLE IF NOT EXISTS controller_operations (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      state TEXT NOT NULL,
      result_json TEXT,
      PRIMARY KEY(workspace_id, operation_id)
    );
  `)
}
