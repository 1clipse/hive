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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-start-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const waitFor = async (cond: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timeout')
}

describe('startWorkflow (non-blocking kickoff)', () => {
  test('returns the initial running record immediately; body runs in background', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'noop.ts')
    writeFileSync(scriptPath, "export const meta = { name: 'n', description: 'd' }\nreturn 1")
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const initial = await store.startWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(initial.status).toBe('running')
      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'completed')
      expect(store.getWorkflowRun(initial.id)?.status).toBe('completed')
    } finally {
      await store.close()
    }
  })

  test('background failure is recorded on the run row', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'boom.ts')
    writeFileSync(
      scriptPath,
      "export const meta = { name: 'b', description: 'd' }\nthrow new Error('background-fail')"
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
      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'failed')
      const final = store.getWorkflowRun(initial.id)
      expect(final?.status).toBe('failed')
      expect(final?.error).toMatch(/background-fail/)
    } finally {
      await store.close()
    }
  })
})
