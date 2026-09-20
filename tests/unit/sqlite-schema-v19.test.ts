import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import {
  CURRENT_SCHEMA_VERSION,
  initializeRuntimeDatabase,
} from '../../src/server/sqlite-schema.js'

const columns = (db: Database, table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  )

describe('schema v19', () => {
  test('adds ephemeral/spawned_by to workers and workflow_run_id/step_index to dispatches', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const workerCols = columns(db, 'workers')
    expect(workerCols.has('ephemeral')).toBe(true)
    expect(workerCols.has('spawned_by')).toBe(true)
    const dispatchCols = columns(db, 'dispatches')
    expect(dispatchCols.has('workflow_run_id')).toBe(true)
    expect(dispatchCols.has('step_index')).toBe(true)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19)
    db.close()
  })

  test('is idempotent on a second initialize', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    initializeRuntimeDatabase(db)
    const applied = (
      db.prepare('SELECT version FROM schema_version WHERE version = 19').all() as unknown[]
    ).length
    expect(applied).toBe(1)
    db.close()
  })
})
