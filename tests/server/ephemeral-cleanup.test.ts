import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getOrchestratorId } from '../../src/server/workspace-store-support.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const dirs: string[] = []
const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hive-ephem-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

const waitFor = async (assertion: () => void, timeoutMs = 3000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTestPath(dir)
})

describe('ephemeral worker boot cleanup', () => {
  test('ephemeral workers are removed when the runtime restarts; persistent workers survive', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store1 = createRuntimeStore({ dataDir })
    const ws = store1.createWorkspace(workspacePath, 'WS')
    store1.addWorker(ws.id, { name: 'alice', role: 'coder' })
    store1.addWorkerWithLaunch(
      ws.id,
      { name: 'verify-1', role: 'reviewer', ephemeral: true, spawnedBy: 'workflow' },
      { command: 'claude', args: [] }
    )
    await store1.close()

    // Restart over the SAME data dir → boot cleanup runs during hydration.
    const store2 = createRuntimeStore({ dataDir })
    const names = store2.listWorkers(ws.id).map((w) => w.name)
    expect(names).toContain('alice')
    expect(names).not.toContain('verify-1')
    await store2.close()
  })
})

describe('ephemeral worker cascade on orchestrator exit', () => {
  test('orchestrator-spawned ephemeral workers are dismissed when the orchestrator PTY exits', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.addWorkerWithLaunch(
        ws.id,
        { name: 'orch-child', role: 'reviewer', ephemeral: true, spawnedBy: 'orchestrator' },
        { command: 'claude', args: [] }
      )
      store.addWorker(ws.id, { name: 'persistent', role: 'coder' })

      // Start the orchestrator with a command that exits immediately, so its
      // PTY onExit fires the cascade. No node-pty mock — a real PTY runs `true`.
      store.configureAgentLaunch(ws.id, getOrchestratorId(ws.id), {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      })
      await store.startAgent(ws.id, getOrchestratorId(ws.id), { hivePort: '0' })

      await waitFor(() => {
        const names = store.listWorkers(ws.id).map((w) => w.name)
        expect(names).toContain('persistent')
        expect(names).not.toContain('orch-child')
      })
    } finally {
      await store.close()
    }
  })
})
