import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WINDOWS_CONTROL_C_EXIT_CODE } from '../../src/server/agent-exit-classification.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import { createAgentSessionStore } from '../../src/server/agent-session-store.js'
import { encodeClaudeProjectPath } from '../../src/server/session-capture-claude.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const tempDirs: string[] = []
const originalCodexHome = process.env.CODEX_HOME

const createClaudeSessionRoot = (cwd: string, sessionId: string) => {
  const root = join(tmpdir(), `hive-resume-failure-${crypto.randomUUID()}`)
  const projectDir = join(root, encodeClaudeProjectPath(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), '{}\n')
  tempDirs.push(root)
  process.env.HIVE_CLAUDE_PROJECTS_DIR = root
}

const createCodexSessionRoot = (cwd: string, sessionId: string) => {
  const root = join(tmpdir(), `hive-codex-resume-failure-${crypto.randomUUID()}`)
  const sessionDir = join(root, 'sessions', '2026', '07', '07')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({ payload: { cwd, id: sessionId }, type: 'session_meta' })}\n`
  )
  tempDirs.push(root)
  process.env.CODEX_HOME = root
}

const runResumeExitScenario = async (
  exitCode: number,
  input: { command?: 'claude' | 'codex'; sessionExists?: boolean } = {}
) => {
  const cwd = '/tmp/hive-resume-failure-workspace'
  const staleSessionId = '77777777-7777-4777-8777-777777777777'
  const command = input.command ?? 'claude'
  const sessionExists = input.sessionExists ?? true
  if (sessionExists && command === 'claude') createClaudeSessionRoot(cwd, staleSessionId)
  if (sessionExists && command === 'codex') createCodexSessionRoot(cwd, staleSessionId)
  const dbPath = join(tmpdir(), `hive-resume-failure-db-${crypto.randomUUID()}.sqlite`)
  const db = new Database(dbPath)
  tempDirs.push(dbPath)
  initializeRuntimeDatabase(db)
  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    'ws-1',
    'Alpha',
    cwd,
    Date.now()
  )
  db.prepare(
    'INSERT INTO workers (id, workspace_id, name, description, role, last_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('agent-1', 'ws-1', 'Alice', 'Coder', 'coder', staleSessionId, Date.now())
  db.prepare(
    'INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
  ).run('agent-1', 'ws-1', staleSessionId, Date.now())
  const sessionStore = createAgentSessionStore(db)
  let runIndex = 0
  const startArgs: Array<string[] | undefined> = []
  const runtime = createAgentRuntime(
    {
      getRun: (runId) => ({
        agentId: 'agent-1',
        exitCode: runId === 'run-1' ? exitCode : null,
        output: '',
        pid: 1,
        runId,
        status: runId === 'run-1' ? 'error' : 'running',
      }),
      startAgent: async (input) => {
        runIndex += 1
        const runId = `run-${runIndex}`
        startArgs.push(input.args)
        if (runId === 'run-1') {
          input.onExit?.({ runId, exitCode })
        }
        return {
          agentId: 'agent-1',
          exitCode: runId === 'run-1' ? exitCode : null,
          output: '',
          pid: 1,
          runId,
          status: runId === 'run-1' ? 'error' : 'starting',
        }
      },
      getOutputBus: () => outputBus,
      pauseRun: () => {},
      removeRun: () => {},
      resizeRun: () => {},
      resumeRun: () => {},
      stopRun: () => {},
      writeInput: () => {},
    },
    {
      insertAgentRun: () => {},
      listAgentRuns: () => [],
      listLaunchConfigs: () => [
        {
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          config: {
            command,
            args: command === 'claude' ? ['--dangerously-skip-permissions'] : [],
            resumeArgsTemplate:
              command === 'claude' ? '--resume {session_id}' : 'resume {session_id}',
            sessionIdCapture:
              command === 'claude'
                ? {
                    pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
                    source: 'claude_project_jsonl_dir',
                  }
                : {
                    pattern: '~/.codex/sessions/**/*.jsonl',
                    source: 'codex_session_jsonl_dir',
                  },
          },
        },
      ],
      deleteLaunchConfig: () => {},
      markUnfinishedRunsStale: () => {},
      saveLaunchConfig: () => {},
      updatePersistedRun: () => {},
    },
    sessionStore,
    () => undefined,
    () => {}
  )

  await runtime.startAgent({ id: 'ws-1', name: 'A', path: cwd }, 'agent-1', { hivePort: '4010' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runtime.startAgent({ id: 'ws-1', name: 'A', path: cwd }, 'agent-1', { hivePort: '4010' })

  return { db, sessionStore, staleSessionId, startArgs }
}

afterEach(() => {
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('claude session resume failure', () => {
  test('preserves existing captured session id after resumed Claude run exits non-zero', async () => {
    const { db, sessionStore, staleSessionId, startArgs } = await runResumeExitScenario(1)

    expect(startArgs[0]).toEqual(['--resume', staleSessionId, '--dangerously-skip-permissions'])
    expect(startArgs[1]).toEqual(['--resume', staleSessionId, '--dangerously-skip-permissions'])
    expect(sessionStore.getLastSessionId('ws-1', 'agent-1')).toBe(staleSessionId)
    expect(
      db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get('agent-1') as {
        last_session_id: string | null
      }
    ).toEqual({ last_session_id: staleSessionId })

    db.close()
  })

  test('preserves existing Codex session id after resumed run exits non-zero', async () => {
    const { db, sessionStore, staleSessionId, startArgs } = await runResumeExitScenario(1, {
      command: 'codex',
    })

    expect(startArgs[0]).toEqual(['resume', staleSessionId])
    expect(startArgs[1]).toEqual(['resume', staleSessionId])
    expect(sessionStore.getLastSessionId('ws-1', 'agent-1')).toBe(staleSessionId)
    expect(
      db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get('agent-1') as {
        last_session_id: string | null
      }
    ).toEqual({ last_session_id: staleSessionId })

    db.close()
  })

  test('clears stale Codex session id when no captured session exists', async () => {
    const { db, sessionStore, startArgs } = await runResumeExitScenario(1, {
      command: 'codex',
      sessionExists: false,
    })

    expect(startArgs[0]).toEqual(['resume', '77777777-7777-4777-8777-777777777777'])
    expect(startArgs[1]).toEqual([])
    expect(sessionStore.getLastSessionId('ws-1', 'agent-1')).toBeUndefined()
    expect(
      db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get('agent-1') as {
        last_session_id: string | null
      }
    ).toEqual({ last_session_id: null })

    db.close()
  })

  test('preserves resumed session id after Windows Ctrl-C exit so restart can resume again', async () => {
    const { db, sessionStore, staleSessionId, startArgs } = await runResumeExitScenario(
      WINDOWS_CONTROL_C_EXIT_CODE
    )

    expect(startArgs[0]).toEqual(['--resume', staleSessionId, '--dangerously-skip-permissions'])
    expect(startArgs[1]).toEqual(['--resume', staleSessionId, '--dangerously-skip-permissions'])
    expect(sessionStore.getLastSessionId('ws-1', 'agent-1')).toBe(staleSessionId)
    expect(
      db.prepare('SELECT last_session_id FROM workers WHERE id = ?').get('agent-1') as {
        last_session_id: string | null
      }
    ).toEqual({ last_session_id: staleSessionId })

    db.close()
  })
})
