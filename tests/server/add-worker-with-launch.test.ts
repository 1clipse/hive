import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const tempDirs: string[] = []
const makeWorkspacePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-m1a-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('addWorkerWithLaunch', () => {
  test('creates the worker and its launch config together', () => {
    const store = createRuntimeStore()
    const ws = store.createWorkspace(makeWorkspacePath(), 'A')
    const worker = store.addWorkerWithLaunch(
      ws.id,
      { name: 'verify-1', role: 'reviewer', ephemeral: true, spawnedBy: 'workflow' },
      { command: 'claude', args: [] }
    )
    expect(store.peekAgentLaunchConfig(ws.id, worker.id)).toMatchObject({ command: 'claude' })
    expect(store.getWorker(ws.id, worker.id).ephemeral).toBe(true)
    expect(store.getWorker(ws.id, worker.id).spawnedBy).toBe('workflow')
  })

  test('rolls back the worker when the launch config write fails (no orphan)', () => {
    const store = createRuntimeStore()
    const ws = store.createWorkspace(makeWorkspacePath(), 'B')
    vi.spyOn(store, 'configureAgentLaunch').mockImplementation(() => {
      throw new Error('launch config write failed')
    })
    expect(() =>
      store.addWorkerWithLaunch(
        ws.id,
        { name: 'verify-2', role: 'reviewer' },
        {
          command: 'claude',
          args: [],
        }
      )
    ).toThrow(/launch config write failed/)
    // No orphan worker left behind in the roster.
    expect(store.listWorkers(ws.id).some((w) => w.name === 'verify-2')).toBe(false)
  })
})
