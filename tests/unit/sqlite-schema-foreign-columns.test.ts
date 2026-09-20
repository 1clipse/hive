import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

// Simulates a "foreign-built" DB: a previous Hive version migrated PAST v19
// using a DIFFERENT v19 migration, so schema_version already lists 19 but
// none of the v19 columns exist on the tables. The version-gated migration
// is skipped — we rely on the idempotent ALTERs in the base init block.
const buildForeignDb = () => {
  const db = new Database(':memory:')
  // Bootstrap a minimal "previous-version" workers/dispatches WITHOUT the
  // v19 columns, then stamp schema_version through 27 so the gated migrations
  // are all "already applied."
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, created_at INTEGER);
    CREATE TABLE workers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT,
      description TEXT,
      role TEXT,
      created_at INTEGER
    );
    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      from_agent_id TEXT,
      to_agent_id TEXT,
      text TEXT,
      status TEXT,
      created_at INTEGER,
      delivered_at INTEGER,
      submitted_at INTEGER,
      reported_at INTEGER,
      report_text TEXT,
      artifacts TEXT,
      sequence INTEGER
    );
  `)
  for (let v = 1; v <= 27; v++) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, 0)
  }
  return db
}

describe('schema column additions survive a foreign-built DB', () => {
  test('workers gets ephemeral + spawned_by even when v19 migration is skipped', () => {
    const db = buildForeignDb()
    initializeRuntimeDatabase(db)
    const cols = new Set(
      (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    expect(cols.has('ephemeral')).toBe(true)
    expect(cols.has('spawned_by')).toBe(true)
    db.close()
  })

  test('dispatches gets workflow_run_id + step_index even when v19 migration is skipped', () => {
    const db = buildForeignDb()
    initializeRuntimeDatabase(db)
    const cols = new Set(
      (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    expect(cols.has('workflow_run_id')).toBe(true)
    expect(cols.has('step_index')).toBe(true)
    db.close()
  })

  test('the column-add path is idempotent across multiple init calls', () => {
    const db = buildForeignDb()
    try {
      initializeRuntimeDatabase(db)
      initializeRuntimeDatabase(db)

      const workerColumns = (
        db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>
      ).map((column) => column.name)
      const dispatchColumns = (
        db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>
      ).map((column) => column.name)

      expect(workerColumns.filter((column) => column === 'ephemeral')).toHaveLength(1)
      expect(workerColumns.filter((column) => column === 'spawned_by')).toHaveLength(1)
      expect(dispatchColumns.filter((column) => column === 'workflow_run_id')).toHaveLength(1)
      expect(dispatchColumns.filter((column) => column === 'step_index')).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
