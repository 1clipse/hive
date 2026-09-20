import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

describe('schema v21', () => {
  test('creates workflow_schedules with the expected columns', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const cols = new Set(
      (db.prepare('PRAGMA table_info(workflow_schedules)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    for (const col of [
      'id',
      'workspace_id',
      'script_path',
      'cron',
      'args',
      'enabled',
      'last_run_at',
      'next_run_at',
      'created_at',
      'updated_at',
    ]) {
      expect(cols.has(col)).toBe(true)
    }
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(21)
    db.close()
  })

  test('is idempotent on a second initialize', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    initializeRuntimeDatabase(db)
    const applied = (
      db.prepare('SELECT version FROM schema_version WHERE version = 21').all() as unknown[]
    ).length
    expect(applied).toBe(1)
    db.close()
  })

  test('creates workflow_schedules even when schema_version already lists 21 (foreign-migrated DB)', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)')
    for (let v = 1; v <= 25; v++) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v, 0)
    }
    initializeRuntimeDatabase(db)
    const exists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_schedules'"
      )
      .get()
    expect(exists).toBeTruthy()
    db.close()
  })
})
