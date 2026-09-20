import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getWorkflowAgentId } from '../../src/server/workspace-store-support.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) removeTestPath(d)
})
const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-route-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('reportTask routes via dispatch.fromAgentId', () => {
  test('workflow-dispatched reports resolve the awaiter and skip the orchestrator PTY forward', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const worker = store.addWorkerWithLaunch(
        ws.id,
        { name: 'alice', role: 'coder', ephemeral: true, spawnedBy: 'workflow' },
        { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }
      )
      // NO orchestrator PTY — proves the report does NOT touch it.
      const dispatch = await store.dispatchTaskByWorkerName(ws.id, 'alice', 'hi', {
        fromAgentId: getWorkflowAgentId(ws.id),
        hivePort: '0',
      })

      const awaiter = store.getWorkflowDispatchAwaiter()
      const pending = awaiter.awaitReport(dispatch.id, 3000)

      const result = store.reportTask(ws.id, worker.id, {
        text: 'done',
        dispatchId: dispatch.id,
      })
      expect(result.forwarded).toBe(true)
      expect(result.forwardError).toBeNull()
      await expect(pending).resolves.toMatchObject({ text: 'done' })
    } finally {
      await store.close()
    }
  })
})
