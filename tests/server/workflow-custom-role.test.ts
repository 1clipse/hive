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
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-custom-role-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  return { dataDir, workspacePath }
}

/* Capture-then-report helper: snapshots the launch config of the first
   workflow-spawned worker for `workspaceId`, then resolves with that
   snapshot AND auto-replies to the dispatch so the run can complete.
   Returns a stop() callback for cleanup. */
const captureLaunchAndReply = (
  store: ReturnType<typeof createRuntimeStore>,
  workspaceId: string,
  text: string
): { captured: Promise<{ command: string; args?: string[] } | undefined>; stop: () => void } => {
  let stopped = false
  let resolveCaptured!: (value: { command: string; args?: string[] } | undefined) => void
  const captured = new Promise<{ command: string; args?: string[] } | undefined>((res) => {
    resolveCaptured = res
  })
  let alreadyCaptured = false
  void (async () => {
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 10))
      if (stopped) return
      try {
        const submitted = store
          .listDispatches(workspaceId, { status: 'submitted' })
          .filter((d) => d.workflowRunId !== null)
        for (const d of submitted) {
          if (!alreadyCaptured) {
            alreadyCaptured = true
            // Capture the launch config BEFORE replying — replying
            // triggers worker dismissal and the row vanishes.
            const config = store.peekAgentLaunchConfig(workspaceId, d.toAgentId)
            resolveCaptured(config)
          }
          store.reportTask(workspaceId, d.toAgentId, { text, dispatchId: d.id })
        }
      } catch {
        return
      }
    }
  })()
  return {
    captured,
    stop: () => {
      stopped = true
      if (!alreadyCaptured) resolveCaptured(undefined)
    },
  }
}

describe('workflow agentType resolves workspace custom roles (TIER 2 #4)', () => {
  test('agentType matching a custom role-template name clones its command + args into the spawned worker', async () => {
    /* The anchor for TIER 2: Hive's signature lever over CC's in-process
       Workflow is the per-workspace custom role library. Before this,
       agent() was clamped to the 4 built-in WorkerRoles, so a workflow
       couldn't target a curated "security-reviewer" template and the
       user's whole template registry was invisible to workflows. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['codex'], originalPath)
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.createRoleTemplate({
        name: 'security-reviewer',
        roleType: 'custom',
        description: 'audits for security bugs',
        defaultCommand: 'codex',
        defaultArgs: ['--system', 'You are a security reviewer.'],
        defaultEnv: {},
      })

      const scriptPath = join(workspacePath, 'custom-role.ts')
      writeFileSync(
        scriptPath,
        [
          "export const meta = { name: 'custom-role', description: 'd' }",
          "await agent('audit me', { agentType: 'security-reviewer', label: 'sec-1' })",
          'return 1',
        ].join('\n')
      )
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        const run = await store.runWorkflow({
          workspaceId: ws.id,
          scriptPath,
          hivePort: '0',
        })
        expect(run.status).toBe('completed')
        const observed = await captured
        // The whole point — the template's command + args appeared on the
        // spawned worker's launch config, not the 'claude' default.
        expect(observed?.command).toBe('codex')
        expect(observed?.args).toEqual(['--system', 'You are a security reviewer.'])
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  })

  test('agentType matching is case-insensitive (TIER 2 #4)', async () => {
    /* Authors write `agentType: 'Security-Reviewer'` and `'security-reviewer'`
       interchangeably; the resolver should match regardless of case to
       avoid silent fallback-to-coder traps. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['codex'], originalPath)
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.createRoleTemplate({
        name: 'Security-Reviewer',
        roleType: 'custom',
        description: 'd',
        defaultCommand: 'codex',
        defaultArgs: ['--marker', 'matched'],
        defaultEnv: {},
      })
      const scriptPath = join(workspacePath, 'case.ts')
      writeFileSync(
        scriptPath,
        [
          "export const meta = { name: 'case', description: 'd' }",
          "await agent('go', { agentType: 'SECURITY-reviewer' })",
          'return 1',
        ].join('\n')
      )
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        const run = await store.runWorkflow({
          workspaceId: ws.id,
          scriptPath,
          hivePort: '0',
        })
        expect(run.status).toBe('completed')
        const observed = await captured
        expect(observed?.args).toContain('matched')
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  })

  test('agentType that matches NEITHER a built-in role NOR a custom template throws a clear error (TIER 2 #4)', async () => {
    /* No silent fallback to 'coder' — silent fallback would hide typos
       and make the whole custom-role-library feature feel invisible. */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['codex'], originalPath)
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      const scriptPath = join(workspacePath, 'unknown.ts')
      writeFileSync(
        scriptPath,
        [
          "export const meta = { name: 'unknown', description: 'd' }",
          "await agent('go', { agentType: 'does-not-exist' })",
          'return 1',
        ].join('\n')
      )
      const run = await store.runWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: '0',
      })
      expect(run.status).toBe('failed')
      expect(run.error).toMatch(/does-not-exist/)
      expect(run.error).toMatch(/built-in role|role template/i)
    } finally {
      await store.close()
    }
  })

  test('opts.cli overrides the template default command (TIER 2 #4)', async () => {
    /* The template's defaultCommand is a default — an explicit opts.cli
       wins. Lets authors borrow a template's system prompt args but
       pin a different vendor (e.g. test with codex while the template
       targets claude). */
    const { dataDir, workspacePath } = wsPath()
    prependPassiveWorkflowCliPath(dataDir, ['codex'], originalPath)
    const store = createRuntimeStore({ dataDir, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.settings.createRoleTemplate({
        name: 'auditor',
        roleType: 'reviewer',
        description: 'd',
        defaultCommand: 'claude',
        defaultArgs: ['--system', 'audit'],
        defaultEnv: {},
      })
      const scriptPath = join(workspacePath, 'cli-wins.ts')
      writeFileSync(
        scriptPath,
        [
          "export const meta = { name: 'cli-wins', description: 'd' }",
          "await agent('go', { agentType: 'auditor', cli: 'codex' })",
          'return 1',
        ].join('\n')
      )
      const { captured, stop } = captureLaunchAndReply(store, ws.id, 'ok')
      try {
        await store.runWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
        const observed = await captured
        // Template said 'claude', script said 'codex' → 'codex' wins.
        expect(observed?.command).toBe('codex')
        // Template args still survive.
        expect(observed?.args).toEqual(['--system', 'audit'])
      } finally {
        stop()
      }
    } finally {
      await store.close()
    }
  })
})
