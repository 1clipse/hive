import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getMemoryFilePath } from '../../src/server/team-memory-export.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []
const stores: Array<ReturnType<typeof createRuntimeStore>> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const waitFor = async (assertion: () => void, timeoutMs = 4000, intervalMs = 25) => {
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

describe('team memory export integration', () => {
  test('memory writes export active memory to .hive/memory.md and archive removes it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-memory-export-data-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')
    const worker = store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    const active = store.addMemoryEntry({
      actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
      body: 'Use pnpm for this project.',
      kind: 'decision',
      tags: ['tooling'],
      workspaceId: workspace.id,
    })
    store.addMemoryEntry({
      actor: { id: worker.id, name: worker.name, role: worker.role },
      body: 'Worker candidate should wait for approval before export.',
      kind: 'pitfall',
      tags: ['candidate'],
      workspaceId: workspace.id,
    })
    store.setMemoryPinned(workspace.id, active.id, true)

    await waitFor(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('<!-- hive-memory:generated v1')
      expect(content).toContain('## Decisions')
      expect(content).toContain('Use pnpm for this project.')
      expect(content).toContain('[decision, pinned, source: manual')
      expect(content).toContain('tags: tooling')
      expect(content).toContain('from: Orchestrator')
      expect(content).toContain('## Dream changelog')
      expect(content).not.toContain('Worker candidate should wait')
    })

    store.archiveMemoryEntry(workspace.id, active.id)

    await waitFor(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).not.toContain('Use pnpm for this project.')
      expect(content).toContain('No active memory entries.')
    })
    expect(existsSync(getMemoryFilePath(workspacePath))).toBe(true)
  })
})
