import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-stop-truthful-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const waitFor = async (cond: () => boolean, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timeout')
}

describe('parallel() stop is truthful (TIER 1 #2/#3)', () => {
  test('stopWorkflowRun during in-flight parallel() records status=stopped, not completed', async () => {
    /* Regression for TIER 1 #2+#3: previously parallel/pipeline swallowed
       every rejection (including the stop-triggered cancel) to null. The
       fn body returned `[null, null]` "successfully" and the runner wrote
       status='completed' with that degraded result — lying to the UI and
       to the orchestrator notification.

       With the fix, the per-item catch checks the stoppedRuns marker and
       re-throws when the run is being stopped; Promise.all rejects;
       executeWorkflow's catch path records 'stopped'. Belt-and-suspenders
       check after fn returns also catches the race where a user script
       wraps parallel() in its own .catch(() => null). */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'parallel-hang.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'parallel-hang', description: 'two agents that never report' }",
        'const rs = await parallel([',
        "  () => agent('agent A — never reports'),",
        "  () => agent('agent B — never reports'),",
        '])',
        'return rs',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const initial = await store.startWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(initial.status).toBe('running')

      // Both dispatches need to be in-flight before we stop, otherwise
      // we'd be testing the easier single-agent path.
      await waitFor(
        () =>
          store
            .listDispatches(ws.id, { status: 'submitted' })
            .filter((d) => d.workflowRunId === initial.id).length >= 2
      )

      expect(store.stopWorkflowRun(initial.id)).toBe(true)

      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'stopped')
      const final = store.getWorkflowRun(initial.id)
      // The whole point — must NOT be 'completed'.
      expect(final?.status).toBe('stopped')
      // And must NOT carry the degraded result the old code wrote.
      expect(final?.result).toBeFalsy()
      expect(final?.error).toMatch(/stopped/i)
    } finally {
      await store.close()
    }
  }, 20_000)

  test('stop survives even when the script swallows parallel() rejections itself', async () => {
    /* Belt-and-suspenders: if the workflow author writes their own
       outer .catch() around parallel, the per-item re-throw doesn't
       help — but the post-fn stoppedRuns check still catches it.
       Without that, a defensive script would mask every stop. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'defensive.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'defensive', description: 'author-swallowed parallel errors' }",
        'const rs = await parallel([',
        "  () => agent('agent A').catch(() => 'fallback-a'),",
        "  () => agent('agent B').catch(() => 'fallback-b'),",
        '])',
        'return rs',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const initial = await store.startWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      await waitFor(
        () =>
          store
            .listDispatches(ws.id, { status: 'submitted' })
            .filter((d) => d.workflowRunId === initial.id).length >= 2
      )
      expect(store.stopWorkflowRun(initial.id)).toBe(true)
      await waitFor(() => {
        const r = store.getWorkflowRun(initial.id)
        return r?.status === 'stopped' || r?.status === 'completed'
      })
      const final = store.getWorkflowRun(initial.id)
      expect(final?.status).toBe('stopped')
    } finally {
      await store.close()
    }
  }, 20_000)
})
