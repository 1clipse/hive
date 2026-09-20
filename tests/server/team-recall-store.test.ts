import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamRecallStore } from '../../src/server/team-recall-store.js'

describe('team recall store', () => {
  test('context windows are workspace-local even when global message sequences interleave', () => {
    const db = new Database(':memory:')
    try {
      initializeRuntimeDatabase(db)
      const insert = db.prepare(
        `INSERT INTO messages (
          workspace_id, worker_id, type, from_agent_id, to_agent_id, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      insert.run('ws-1', 'worker-1', 'send', 'orch-1', 'worker-1', 'ws1 before', 1)
      insert.run('ws-2', 'worker-2', 'send', 'orch-2', 'worker-2', 'other workspace gap 1', 2)
      insert.run('ws-2', 'worker-2', 'send', 'orch-2', 'worker-2', 'other workspace gap 2', 3)
      insert.run('ws-1', 'worker-1', 'report', 'worker-1', null, '远程访问链路已恢复', 4)
      insert.run('ws-2', 'worker-2', 'send', 'orch-2', 'worker-2', 'other workspace gap 3', 5)
      insert.run('ws-1', 'worker-1', 'status', 'worker-1', null, 'ws1 after', 6)

      const [hit] = createTeamRecallStore(db).recallMessages('ws-1', '访问链', {
        limit: 1,
        window: 1,
      })

      expect(hit?.context.map((item) => item.text)).toEqual([
        'ws1 before',
        '远程访问链路已恢复',
        'ws1 after',
      ])
    } finally {
      db.close()
    }
  })

  test('finds two-character CJK terms through the short-token fallback', () => {
    const db = new Database(':memory:')
    try {
      initializeRuntimeDatabase(db)
      db.prepare(
        `INSERT INTO messages (
          workspace_id, worker_id, type, from_agent_id, to_agent_id, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('ws-1', 'worker-1', 'report', 'worker-1', null, '远程访问链路已恢复', 1)
      db.prepare(
        `INSERT INTO dispatches (
          id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, report_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('dispatch-1', 'ws-1', 'orch-1', 'worker-1', '检查链路', 'reported', 1, '远程修复完成')

      const results = createTeamRecallStore(db).recallMessages('ws-1', '远程', {
        limit: 5,
        window: 1,
      })

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            indexName: 'like',
            sourceType: 'message',
            text: '远程访问链路已恢复',
          }),
          expect.objectContaining({
            indexName: 'like',
            reportText: '远程修复完成',
            sourceType: 'dispatch',
          }),
        ])
      )
    } finally {
      db.close()
    }
  })
})
