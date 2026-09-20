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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-nest-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('workflow() nesting', () => {
  test('a parent script calls workflow("child") and gets the child run record', async () => {
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/child.ts'),
      "export const meta = { name: 'child', description: 'd' }\nreturn 1"
    )
    writeFileSync(
      join(workspacePath, '.hive/workflows/parent.ts'),
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "const childRun = await workflow('child')",
        'return childRun.status',
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parentScript = join(workspacePath, '.hive/workflows/parent.ts')
      const parent = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath: parentScript,
        hivePort: '0',
      })
      expect(parent.status).toBe('completed')
      // Both runs exist for the workspace, newest-first.
      const runs = store.listWorkspaceWorkflowRuns(ws.id)
      const names = runs.map((r) => r.name)
      expect(names).toContain('parent')
      expect(names).toContain('child')
      const childRecord = runs.find((r) => r.name === 'child')
      expect(childRecord?.status).toBe('completed')
    } finally {
      await store.close()
    }
  })

  test('inline parent (TIER 1 #7): workflow("child") resolves to .hive/workflows/, not CWD', async () => {
    /* Regression for TIER 1 #7: when the parent is fired inline via
       `team workflow run --stdin`, its scriptPath is the synthetic
       `<inline>` token. The old code did `dirname('<inline>')` → '.' and
       resolved `./child.ts` against the runtime CWD — broken for every
       orchestrator-triggered nested workflow. The fix probes the
       synthetic prefix and falls back to the workspace's
       `.hive/workflows/<name>.ts`. */
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/child.ts'),
      "export const meta = { name: 'child', description: 'd' }\nreturn 'from-child'"
    )
    const parentSource = [
      "export const meta = { name: 'inline-parent', description: 'd' }",
      "const childRun = await workflow('child')",
      'return childRun.status',
    ].join('\n')

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const initial = await store.startWorkflowInline({
        workspaceId: ws.id,
        source: parentSource,
        hivePort: '0',
      })
      // Poll until the inline parent terminates (kicks off in background).
      const deadline = Date.now() + 5000
      let final = store.getWorkflowRun(initial.id)
      while (final && final.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        final = store.getWorkflowRun(initial.id)
      }
      // Without the fix this would be 'failed' with an ENOENT on ./child.ts.
      expect(final?.status).toBe('completed')
      const runs = store.listWorkspaceWorkflowRuns(ws.id)
      const childRecord = runs.find((r) => r.name === 'child')
      expect(childRecord?.status).toBe('completed')
    } finally {
      await store.close()
    }
  })

  test('nested workflow() sets parent_run_id on the child so the UI can render a tree (TIER 2 #5)', async () => {
    /* Without parent_run_id, child and parent runs render as siblings
       and the user can't tell which child belonged to which parent —
       especially painful once a script calls workflow() multiple times.
       The schema column is added in sqlite-schema.ts via ensureColumn;
       the runner stamps it on the createRun path. */
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/child.ts'),
      "export const meta = { name: 'child', description: 'd' }\nreturn 'ok'"
    )
    writeFileSync(
      join(workspacePath, '.hive/workflows/parent.ts'),
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "await workflow('child')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parent = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath: join(workspacePath, '.hive/workflows/parent.ts'),
        hivePort: '0',
      })
      expect(parent.status).toBe('completed')
      // Parent must report no parent of its own; child must point to it.
      expect(parent.parentRunId).toBeNull()
      const runs = store.listWorkspaceWorkflowRuns(ws.id)
      const childRecord = runs.find((r) => r.name === 'child')
      expect(childRecord).toBeDefined()
      expect(childRecord?.parentRunId).toBe(parent.id)
    } finally {
      await store.close()
    }
  })

  test('workflow() throws a clear error when the child script does not exist', async () => {
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/parent.ts'),
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "await workflow('missing-child')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parent = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath: join(workspacePath, '.hive/workflows/parent.ts'),
        hivePort: '0',
      })
      expect(parent.status).toBe('failed')
      expect(parent.error).toMatch(/missing-child/)
    } finally {
      await store.close()
    }
  })

  test('child workflow results are cloned into the VM and cannot leak host constructors', async () => {
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/child.ts'),
      "export const meta = { name: 'child', description: 'd' }\nreturn { ok: true }"
    )
    writeFileSync(
      join(workspacePath, '.hive/workflows/parent.ts'),
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "const childRun = await workflow('child')",
        "return childRun['constructor']['constructor']('return process')().version",
      ].join('\n')
    )

    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parent = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath: join(workspacePath, '.hive/workflows/parent.ts'),
        hivePort: '0',
      })
      expect(parent.status).toBe('failed')
      expect(parent.error).toMatch(/code generation|disallowed|process|constructor/i)
      const childRecord = store.listWorkspaceWorkflowRuns(ws.id).find((run) => run.name === 'child')
      expect(childRecord?.status).toBe('completed')
    } finally {
      await store.close()
    }
  })

  test('workflow() rejects reserved Windows device filenames before path lookup', async () => {
    const { dataDir, workspacePath } = wsPath()
    writeFileSync(
      join(workspacePath, '.hive/workflows/parent.ts'),
      [
        "export const meta = { name: 'parent', description: 'd' }",
        "await workflow('NUL')",
        'return 1',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const parent = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath: join(workspacePath, '.hive/workflows/parent.ts'),
        hivePort: '0',
      })
      expect(parent.status).toBe('failed')
      expect(parent.error).toMatch(/reserved Windows device name/i)
    } finally {
      await store.close()
    }
  })
})
