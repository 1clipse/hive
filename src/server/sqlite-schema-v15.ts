import type { Database } from './sqlite.js'

const tableExists = (db: Database, table: string) =>
  Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name: string }
      | undefined
  )

const getDispatchColumns = (db: Database) =>
  new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )

const createDispatchIndexes = (db: Database) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_workspace_created_at
      ON dispatches (workspace_id, sequence);

    CREATE INDEX IF NOT EXISTS idx_dispatches_open_by_worker
      ON dispatches (workspace_id, to_agent_id, status, sequence);
  `)
}

const createModernDispatchesTable = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatches (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      from_agent_id TEXT,
      to_agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      submitted_at INTEGER,
      reported_at INTEGER,
      report_text TEXT,
      artifacts TEXT
    );
  `)
}

const copyLegacyDispatches = (db: Database) => {
  db.exec(`
    INSERT INTO dispatches (
      id,
      workspace_id,
      from_agent_id,
      to_agent_id,
      text,
      status,
      created_at,
      delivered_at,
      submitted_at,
      reported_at,
      report_text,
      artifacts
    )
    SELECT
      id,
      workspace_id,
      from_agent_id,
      to_agent_id,
      text,
      status,
      created_at,
      delivered_at,
      submitted_at,
      reported_at,
      report_text,
      artifacts
    FROM dispatches_legacy_v15
    ORDER BY created_at ASC, rowid ASC;
  `)
}

const completeLegacyCopy = (db: Database) => {
  createModernDispatchesTable(db)
  // Lossless MERGE, not a replace. The half-state can be old: the original
  // bug stamped v15 on an empty live table, so users kept creating NEW
  // dispatches while the pre-migration history stayed stranded in the
  // legacy table. Copy only legacy rows whose id is missing from live;
  // on a duplicated id the live (newer) row wins. Drop the legacy table
  // only after the merge, inside the same transaction.
  db.exec(`
    INSERT INTO dispatches (
      id,
      workspace_id,
      from_agent_id,
      to_agent_id,
      text,
      status,
      created_at,
      delivered_at,
      submitted_at,
      reported_at,
      report_text,
      artifacts
    )
    SELECT
      legacy.id,
      legacy.workspace_id,
      legacy.from_agent_id,
      legacy.to_agent_id,
      legacy.text,
      legacy.status,
      legacy.created_at,
      legacy.delivered_at,
      legacy.submitted_at,
      legacy.reported_at,
      legacy.report_text,
      legacy.artifacts
    FROM dispatches_legacy_v15 legacy
    WHERE NOT EXISTS (
      SELECT 1 FROM dispatches live WHERE live.id = legacy.id
    )
    ORDER BY legacy.created_at ASC, legacy.rowid ASC;
  `)
  db.exec('DROP TABLE dispatches_legacy_v15')
}

export const applySchemaVersion15 = (db: Database) => {
  db.transaction(() => {
    if (tableExists(db, 'dispatches_legacy_v15')) {
      completeLegacyCopy(db)
      createDispatchIndexes(db)
      return
    }

    const dispatchColumns = getDispatchColumns(db)
    if (dispatchColumns.size === 0) return
    if (dispatchColumns.has('sequence')) {
      createDispatchIndexes(db)
      return
    }

    db.exec(`
      DROP INDEX IF EXISTS idx_dispatches_workspace_created_at;
      DROP INDEX IF EXISTS idx_dispatches_open_by_worker;
      ALTER TABLE dispatches RENAME TO dispatches_legacy_v15;
    `)
    createModernDispatchesTable(db)
    copyLegacyDispatches(db)
    db.exec('DROP TABLE dispatches_legacy_v15')
    createDispatchIndexes(db)
  })()
}
