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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-cascade-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('deleteWorkspace cascades workflow tables (TIER 1 #4)', () => {
  test('removing a workspace clears its workflow_runs, schedules, and workflow-tagged dispatches', async () => {
    /* Regression for TIER 1 #4: deleteWorkspace previously only cleared
       messages / agent_launch_configs / agent_sessions / agent_runs /
       workers / workspaces. workflow_schedules and workflow_runs (and
       their attached dispatch rows) were orphaned forever, and the
       scheduler kept firing the dead schedules every tick — permanent
       error-spam loop. */
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/noop.ts'),
      "export const meta = { name: 'noop', description: 'd' }\nreturn 1"
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const scriptPath = join(workspacePath, '.hive/workflows/noop.ts')

      // Plant: a workflow run (with its associated dispatch surface) and a schedule.
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('completed')

      const schedule = store.createWorkflowSchedule({
        workspaceId: ws.id,
        scriptPath,
        cron: '0 0 * * *',
        nextRunAt: Date.now() + 60_000,
        enabled: true,
      })

      // Sanity — both exist now.
      expect(store.listWorkspaceWorkflowRuns(ws.id).length).toBeGreaterThan(0)
      expect(store.listWorkspaceWorkflowSchedules(ws.id).length).toBe(1)
      expect(store.getWorkflowSchedule(schedule.id)).toBeDefined()

      await store.deleteWorkspace(ws.id)

      // Confirm: the workspace + its workflow rows are all gone, not just the workspace row.
      expect(store.listWorkspaces().some((w) => w.id === ws.id)).toBe(false)
      expect(store.getWorkflowSchedule(schedule.id)).toBeUndefined()
      // The run record itself: getWorkflowRun should no longer find it,
      // since the row was deleted. If the cascade is reverted, the stale
      // row would survive (and the assertion would fail).
      expect(store.getWorkflowRun(run.id)).toBeUndefined()
    } finally {
      await store.close()
    }
  })
})
