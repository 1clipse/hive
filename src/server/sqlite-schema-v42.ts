import type { Database } from './sqlite.js'

/** Persistent task-local communication; no new agent lifecycle states. */
export const applySchemaVersion42 = (db: Database) => {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN parent_dispatch_id TEXT;
    ALTER TABLE dispatches ADD COLUMN root_dispatch_id TEXT;
    ALTER TABLE dispatches ADD COLUMN seen_seq INTEGER NOT NULL DEFAULT 0;
    UPDATE dispatches SET root_dispatch_id = id;
    CREATE INDEX idx_dispatches_report_notifications ON dispatches(workspace_id, reported_at, sequence) WHERE status = 'reported';
    CREATE INDEX idx_dispatches_root ON dispatches(workspace_id, root_dispatch_id);
    CREATE TABLE dispatch_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      source_dispatch_id TEXT,
      controller_thread_id TEXT,
      sequence INTEGER NOT NULL,
      from_agent_id TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('note','question','answer','progress')),
      reply_to TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(dispatch_id, sequence)
    );
    CREATE INDEX idx_dispatch_messages_source ON dispatch_messages(source_dispatch_id);
    CREATE INDEX idx_dispatch_messages_reply ON dispatch_messages(reply_to);
    CREATE INDEX idx_dispatch_messages_workspace ON dispatch_messages(workspace_id, created_at);
    CREATE TABLE dispatch_message_outbox (
      message_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('queued','delivering','delivered','cancelled')),
      delivered_at INTEGER,
      error TEXT
    );
    CREATE INDEX idx_dispatch_message_outbox_state ON dispatch_message_outbox(state, message_id);
  `)
}
