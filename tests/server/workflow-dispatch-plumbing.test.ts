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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-plumb-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('dispatchTask plumbs workflow_run_id + step_index', () => {
  test('persists workflowRunId/stepIndex onto the dispatch row', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.addWorkerWithLaunch(
        ws.id,
        { name: 'alice', role: 'coder' },
        { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }
      )

      // Workflow-sourced dispatch carrying run + step identifiers.
      const dispatch = await store.dispatchTaskByWorkerName(ws.id, 'alice', 'hi', {
        fromAgentId: getWorkflowAgentId(ws.id),
        workflowRunId: 'run-1',
        stepIndex: 7,
      })

      expect(dispatch.workflowRunId).toBe('run-1')
      expect(dispatch.stepIndex).toBe(7)
    } finally {
      await store.close()
    }
  })

  test('plain orchestrator dispatch has nullable workflow fields (no regression)', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store = createRuntimeStore({ dataDir })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.addWorker(ws.id, { name: 'alice', role: 'coder' })
      const dispatch = await store.dispatchTaskByWorkerName(ws.id, 'alice', 'hi')
      expect(dispatch.workflowRunId).toBeNull()
      expect(dispatch.stepIndex).toBeNull()
    } finally {
      await store.close()
    }
  })
})
