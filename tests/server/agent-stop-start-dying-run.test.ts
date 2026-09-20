import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) removeTestPath(dir)
})

describe('stop then start does not reuse a dying PTY (#81)', () => {
  test('startAgent after stopAgentRun spawns a new run while SIGTERM is still draining', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-stop-start-dying-'))
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    dirs.push(dataDir)
    const stubborn = join(workspacePath, 'stubborn.js')
    writeFileSync(
      stubborn,
      [
        'process.on("SIGTERM", () => {})',
        'setInterval(() => {}, 1000)',
        'process.stdin.resume()',
      ].join('\n')
    )

    const store = createRuntimeStore({ agentManager: createAgentManager(), dataDir })
    try {
      const workspace = store.createWorkspace(workspacePath, 'Dying')
      const agentId = `${workspace.id}:orchestrator`
      store.configureAgentLaunch(workspace.id, agentId, {
        command: process.execPath,
        args: [stubborn],
      })
      const first = await store.startAgent(workspace.id, agentId, { hivePort: '0' })
      expect(first.status === 'starting' || first.status === 'running').toBe(true)
      store.stopAgentRun(first.runId)
      const second = await store.startAgent(workspace.id, agentId, { hivePort: '0' })
      expect(second.runId).not.toBe(first.runId)
      expect(second.status === 'starting' || second.status === 'running').toBe(true)
    } finally {
      await store.close()
    }
  })
})
