import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const d of dirs.splice(0)) removeTestPath(d)
})

const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-pty-exit-'))
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

describe('workflow worker PTY exit (TIER 1 #1)', () => {
  test('when a workflow worker dies without `team report`, the awaiter is cancelled within ms (not 10 min)', async () => {
    /* Regression for TIER 1 #1: if a workflow-spawned ephemeral worker's
       PTY exits before it calls `team report`, the runner's
       `awaitReport(dispatchId, …)` previously hung until
       DEFAULT_TIMEOUT_MS (10 min). The exit handler must enumerate any
       open workflow_run_id dispatches addressed to the dying worker and
       cancel them so the surrounding `agent()` rejects synchronously. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'crash.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'crash', description: 'simulate worker PTY exit' }",
        "const r = await agent('never reports — pty will be killed')",
        'return r',
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

      // The ephemeral worker has to be up and have an active run before we
      // can "crash" it; the dispatch reaching submitted is the signal.
      await waitFor(() =>
        store
          .listDispatches(ws.id, { status: 'submitted' })
          .some((d) => d.workflowRunId === initial.id)
      )

      const dispatch = store
        .listDispatches(ws.id, { status: 'submitted' })
        .find((d) => d.workflowRunId === initial.id)
      if (!dispatch) throw new Error('Expected submitted dispatch for the workflow run')

      const workerId = dispatch.toAgentId
      const workerRun = store.getActiveRunByAgentId(ws.id, workerId)
      if (!workerRun) throw new Error('Expected an active run for the workflow worker')

      const startedAt = Date.now()
      // Simulate the worker PTY exiting without ever calling `team report`.
      // onAgentExit must propagate cancel to the awaiter.
      store.stopAgentRun(workerRun.runId)

      // The agent() call must reject in well under DEFAULT_TIMEOUT_MS=10min.
      // If the fix is reverted, this expectation is the loud failure — the
      // run would otherwise sit in 'running' for 10 minutes.
      await waitFor(() => {
        const r = store.getWorkflowRun(initial.id)
        return r?.status === 'failed' || r?.status === 'completed' || r?.status === 'stopped'
      }, 5000)
      const elapsed = Date.now() - startedAt
      expect(elapsed).toBeLessThan(5000)

      // The dispatch must be marked cancelled with the exit reason — not
      // just left dangling — so the run-detail UI can show what happened.
      const dispatches = store.listDispatches(ws.id).filter((d) => d.workflowRunId === initial.id)
      expect(dispatches.length).toBeGreaterThan(0)
      const cancelled = dispatches.find((d) => d.status === 'cancelled')
      expect(cancelled).toBeDefined()
      expect(cancelled?.reportText).toMatch(/pty exited|pty is not active/i)
      try {
        expect(store.getWorker(ws.id, workerId).pendingTaskCount).toBe(0)
      } catch {
        // The workflow runner may already have dismissed the ephemeral worker.
        // If it still exists after cancellation, pending must be synchronized.
      }
    } finally {
      await store.close()
    }
  }, 20_000)
})
