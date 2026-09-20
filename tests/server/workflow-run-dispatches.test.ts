import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const dirs: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  vi.unstubAllEnvs()
  process.env.PATH = originalPath
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})
const wsPath = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-rundispatches-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

describe('listWorkflowRunDispatches', () => {
  test('returns empty for a run that has no agent() calls', async () => {
    const { dataDir, workspacePath } = wsPath()
    const scriptPath = join(workspacePath, 'noop.ts')
    writeFileSync(scriptPath, "export const meta = { name: 'noop', description: 'd' }\nreturn 1")
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const run = await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(run.status).toBe('completed')
      expect(store.listWorkflowRunDispatches(run.id)).toEqual([])
    } finally {
      await store.close()
    }
  })

  test.each([
    0, 2000,
  ])('returns the run dispatch with workflowRunId / stepIndex (startup ACK delay %i ms)', async (delayMs) => {
    vi.stubEnv('HIVE_FAKE_CLI_FIRST_PASTE_ACK_DELAY_MS', String(delayMs))
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'one.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'one', description: 'd' }",
        "const r = await agent('hello')",
        'return r',
      ].join('\n')
    )
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    const stopReplier = new AbortController()
    let replier: Promise<ReturnType<typeof store.reportTask>> | undefined
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')

      // Wait for persisted submission, including the real PTY startup handshake.
      // Observe both promises immediately so a replier failure cannot leave the
      // workflow waiting for its ten-minute default report timeout.
      replier = (async () => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          stopReplier.signal.throwIfAborted()
          const submitted = store
            .listDispatches(ws.id, { status: 'submitted' })
            .find((d) => d.workflowRunId !== null)
          if (submitted) {
            return store.reportTask(ws.id, submitted.toAgentId, {
              text: 'hello back',
              dispatchId: submitted.id,
            })
          }
          await delay(20, undefined, { signal: stopReplier.signal })
        }
        throw new Error('Workflow dispatch was not submitted within 15 seconds')
      })()

      const [run, report] = await Promise.all([
        store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' }),
        replier,
      ])
      expect(report.forwarded).toBe(true)
      expect(run.status).toBe('completed')

      const dispatches = store.listWorkflowRunDispatches(run.id)
      expect(dispatches.length).toBe(1)
      expect(dispatches[0]?.workflowRunId).toBe(run.id)
      expect(dispatches[0]?.stepIndex).toBe(1)
      expect(dispatches[0]?.reportText).toBe('hello back')
    } finally {
      stopReplier.abort()
      if (replier) await Promise.allSettled([replier])
      await store.close()
    }
  }, 20_000)
})
