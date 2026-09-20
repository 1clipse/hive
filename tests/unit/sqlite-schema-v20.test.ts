import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

describe('schema v20', () => {
  test('creates workflow_runs with the expected columns', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const cols = new Set(
      (db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    for (const col of [
      'id',
      'workspace_id',
      'script_path',
      'script_hash',
      'name',
      'status',
      'phase',
      'args',
      'started_at',
      'finished_at',
      'error',
      'created_at',
    ]) {
      expect(cols.has(col)).toBe(true)
    }
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20)
    db.close()
  })

  test('is idempotent on a second initialize', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    initializeRuntimeDatabase(db)
    const applied = (
      db.prepare('SELECT version FROM schema_version WHERE version = 20').all() as unknown[]
    ).length
    expect(applied).toBe(1)
    db.close()
  })

  test('creates workflow_runs even when schema_version already lists 20 (shared data dir migrated by a newer Hive)', () => {
    // The global ~/.config/hive DB can be migrated past v20 by a newer Hive
    // whose v20 was a DIFFERENT migration, so OUR v20 ALTER is skipped. The
    // base CREATE-IF-NOT-EXISTS block must still materialize workflow_runs.
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)')
    for (let v = 1; v <= 25; v++) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, 0)
    }
    initializeRuntimeDatabase(db)
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'")
      .get()
    expect(exists).toBeTruthy()
    db.close()
  })
})
