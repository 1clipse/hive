import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('schema v35', () => {
  test('refreshes built-in role template descriptions to the default English contract', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    db.prepare('UPDATE role_templates SET description = ? WHERE id = ?').run(
      '你是实现型 Coder',
      'coder'
    )
    db.prepare('DELETE FROM schema_version WHERE version = 35').run()

    initializeRuntimeDatabase(db)

    const row = db
      .prepare('SELECT description FROM role_templates WHERE id = ? AND is_builtin = 1')
      .get('coder') as { description: string }
    expect(row.description).toContain('You are an implementation Coder')
    expect(row.description).toContain('Read relevant files and existing patterns')
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 35').get()).toBeTruthy()
    db.close()
  })
})
