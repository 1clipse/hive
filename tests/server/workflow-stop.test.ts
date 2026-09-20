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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-stop-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const waitFor = async (cond: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('waitFor timeout')
}

describe('stopWorkflowRun', () => {
  test('stops a run with an in-flight agent() call; marks status=stopped', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'hang.ts')
    // This script never receives a report, so it would wait until the awaiter
    // times out (10 min by default). stopWorkflowRun must cut that short.
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'hang', description: 'd' }",
        "const r = await agent('hello, never reported')",
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

      // Wait for the dispatch to appear before stopping.
      await waitFor(
        () =>
          store
            .listDispatches(ws.id, { status: 'submitted' })
            .some((d) => d.workflowRunId === initial.id),
        10_000
      )

      const ok = store.stopWorkflowRun(initial.id)
      expect(ok).toBe(true)

      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'stopped')
      const final = store.getWorkflowRun(initial.id)
      expect(final?.status).toBe('stopped')
      expect(final?.error).toMatch(/stopped/i)
      // Ephemeral worker is dismissed.
      expect(store.listWorkers(ws.id).length).toBe(0)
    } finally {
      await store.close()
    }
  })

  test('stopWorkflowRun on a non-running run returns false', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'noop.ts')
    writeFileSync(scriptPath, "export const meta = { name: 'noop', description: 'd' }\nreturn 1")
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('completed')
      expect(store.stopWorkflowRun(run.id)).toBe(false)
    } finally {
      await store.close()
    }
  })

  test('stopWorkflowRun persists stopped even when the script has no open dispatch awaiter', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'pure-js-hang.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'pure-js-hang', description: 'd' }",
        'await new Promise(() => {})',
        'return 1',
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

      expect(store.stopWorkflowRun(initial.id)).toBe(true)
      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'stopped')
      expect(store.getWorkflowRun(initial.id)?.error).toMatch(/stopped/i)
      expect(store.listDispatches(ws.id, { status: 'submitted' })).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  test('stopWorkflowRun terminates the script container so caught cancellation cannot dispatch again', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'catch-then-dispatch.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'catch-then-dispatch', description: 'd' }",
        'try {',
        "  await agent('first never reports')",
        '} catch {}',
        "await agent('after-stop must not dispatch')",
        'return 1',
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
      await waitFor(() =>
        store
          .listDispatches(ws.id, { status: 'submitted' })
          .some((dispatch) => dispatch.workflowRunId === initial.id)
      )

      expect(store.stopWorkflowRun(initial.id)).toBe(true)
      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'stopped')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(store.listWorkflowRunDispatches(initial.id).map((dispatch) => dispatch.text)).toEqual([
        'first never reports',
      ])
      expect(store.listWorkers(ws.id)).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  test('stopping a parent workflow also stops running nested child workflows', async () => {
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
    writeFileSync(
      join(workspacePath, '.hive/workflows/child.ts'),
      [
        "export const meta = { name: 'child', description: 'd' }",
        "return await agent('child never reports')",
      ].join('\n')
    )
    const parentScript = join(workspacePath, '.hive/workflows/parent.ts')
    writeFileSync(
      parentScript,
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "return await workflow('child')",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parent = await store.startWorkflow({
        workspaceId: ws.id,
        scriptPath: parentScript,
        hivePort: '0',
      })

      await waitFor(() => {
        const child = store
          .listWorkspaceWorkflowRuns(ws.id)
          .find((run) => run.name === 'child' && run.parentRunId === parent.id)
        return (
          child?.status === 'running' &&
          store
            .listDispatches(ws.id, { status: 'submitted' })
            .some((dispatch) => dispatch.workflowRunId === child.id)
        )
      })

      expect(store.stopWorkflowRun(parent.id)).toBe(true)

      await waitFor(() => {
        const runs = store.listWorkspaceWorkflowRuns(ws.id)
        const child = runs.find((run) => run.name === 'child' && run.parentRunId === parent.id)
        return store.getWorkflowRun(parent.id)?.status === 'stopped' && child?.status === 'stopped'
      })
      expect(store.getWorkflowRun(parent.id)?.status).toBe('stopped')
      const child = store
        .listWorkspaceWorkflowRuns(ws.id)
        .find((run) => run.name === 'child' && run.parentRunId === parent.id)
      expect(child?.status).toBe('stopped')
    } finally {
      await store.close()
    }
  }, 20_000)
})
