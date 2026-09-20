import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTestPath(dir)
})

describe('worker dismiss outbox cleanup (#85)', () => {
  test('deleteWorker clears a pending outbox row for an open dispatch beyond the default 100-row page', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-dismiss-outbox-'))
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    dirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    try {
      const workspace = store.createWorkspace(workspacePath, 'Page')
      const worker = store.addWorker(workspace.id, { name: 'Dee', role: 'coder' })
      const orchId = `${workspace.id}:orchestrator`
      for (let i = 0; i < 101; i++) {
        await store.dispatchTask(workspace.id, worker.id, `task ${i}`, {
          autoStartWorker: false,
          fromAgentId: orchId,
        })
      }
      const newest = store.listOpenDispatches(workspace.id).at(-1)
      if (!newest) throw new Error('expected open dispatches')
      expect(store.listDispatches(workspace.id).some((row) => row.id === newest.id)).toBe(false)

      const seed = new Database(join(dataDir, 'runtime.sqlite'))
      seed
        .prepare(
          `INSERT INTO report_outbox (workspace_id, target_agent_id, dispatch_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(workspace.id, orchId, newest.id, 'STALE_PENDING', Date.now())
      const seeded = seed
        .prepare('SELECT payload FROM report_outbox WHERE dispatch_id = ?')
        .get(newest.id) as { payload: string } | undefined
      seed.close()
      expect(seeded?.payload).toBe('STALE_PENDING')

      store.deleteWorker(workspace.id, worker.id)

      const check = new Database(join(dataDir, 'runtime.sqlite'))
      const row = check
        .prepare(
          'SELECT payload, delivered_at FROM report_outbox WHERE dispatch_id = ? AND delivered_at IS NULL'
        )
        .get(newest.id) as { payload: string; delivered_at: number | null } | undefined
      check.close()
      expect(row).toBeDefined()
      expect(row?.payload).not.toBe('STALE_PENDING')
      expect(row?.payload).toContain('DROPPED')
    } finally {
      await store.close()
    }
  })
})
