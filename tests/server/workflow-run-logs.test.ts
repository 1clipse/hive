import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-logs-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('workflow run log pipeline (TIER 2 #3)', () => {
  test('log() calls persist as workflow_run_logs rows in oldest-first order', async () => {
    /* Before this, log() wrote to server stdout only — the Drawer
       couldn't render the narrator lane and the orchestrator's
       completion reminder had no way to splice in narrator context.
       Now log() rows go through the workflow_run_log_store and
       listWorkflowRunLogs returns them in insertion order. */
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'noisy.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'noisy', description: 'd' }",
        "log('Phase 1 starting')",
        "log('Discovered 3 candidates')",
        "log('Phase 2 starting')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('completed')
      const lines = store.listWorkflowRunLogs(run.id).map((entry) => entry.message)
      expect(lines).toEqual(['Phase 1 starting', 'Discovered 3 candidates', 'Phase 2 starting'])
    } finally {
      await store.close()
    }
  })

  test('runs that never call log() return an empty array (no synthetic rows)', async () => {
    /* Sanity check: the Drawer's narrator lane is hidden when the array
       is empty, so we must not silently create empty rows. */
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'silent.ts')
    writeFileSync(scriptPath, "export const meta = { name: 'silent', description: 'd' }\nreturn 1")
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('completed')
      expect(store.listWorkflowRunLogs(run.id)).toEqual([])
    } finally {
      await store.close()
    }
  })

  test('deleteWorkspace cascades workflow_run_logs along with workflow_runs (TIER 2 #3 + TIER 1 #4)', async () => {
    /* The TIER 1 #4 cascade only knew about workflow_schedules,
       workflow_runs, and dispatches. After #3 added a fourth child
       table, the cascade was extended to wipe its rows before deleting
       workflow_runs (otherwise stale narrator lines would accumulate
       forever after a workspace delete). */
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'noisy.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'noisy', description: 'd' }",
        "log('first')",
        "log('second')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(store.listWorkflowRunLogs(run.id).length).toBe(2)
      await store.deleteWorkspace(ws.id)
      // After cascade, the workflow_runs row is gone and the logs that
      // hung off it should be gone too. listWorkflowRunLogs against the
      // stale id must return [], not the orphan rows.
      expect(store.listWorkflowRunLogs(run.id)).toEqual([])
    } finally {
      await store.close()
    }
  })
})
