import '../helpers/mock-node-pty.ts'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentRunStore } from '../../src/server/agent-run-store.js'
import { createAgentRuntime } from '../../src/server/agent-runtime.js'
import Database from '../../src/server/sqlite.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const outputBus = {
  clear: () => {},
  publish: () => {},
  subscribe: () => () => {},
}

const sessionStore = {
  clearLastSessionId: () => {},
  getLastSessionId: () => undefined,
  setLastSessionId: () => {},
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
  vi.restoreAllMocks()
})

describe('agent runtime stability (unit)', () => {
  test('run output is capped at 1MB and keeps the tail', async () => {
    const largeOutput = 'a'.repeat(1_500_000)

    const runtime = createAgentRuntime(
      {
        getRun: () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: largeOutput,
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
        startAgent: async () => ({
          agentId: 'agent-1',
          exitCode: null,
          output: '',
          pid: 1,
          runId: 'run-1',
          status: 'running',
        }),
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
            config: { command: process.execPath, args: [] },
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

    const run = await runtime.startAgent({ id: 'ws-1', name: 'A', path: '/tmp/a' }, 'agent-1', {
      hivePort: '4010',
    })

    const snapshot = runtime.getLiveRun(run.runId)
    expect(snapshot.output.length).toBeLessThanOrEqual(1_000_000)
    expect(snapshot.output.slice(-100)).toBe('a'.repeat(100))
  })

  test('invalid args_json falls back to empty args and warns', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-bad-args-'))
    tempDirs.push(dataDir)

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    db.exec(`
      CREATE TABLE agent_launch_configs (
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        command_preset_id TEXT,
        interactive_command TEXT,
        preset_augmentation_disabled INTEGER NOT NULL DEFAULT 0,
        resume_args_template TEXT,
        session_id_capture_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, agent_id)
      );
    `)
    db.prepare(
      `INSERT INTO agent_launch_configs (
         workspace_id,
         agent_id,
         command,
         args_json,
         command_preset_id,
         interactive_command,
         preset_augmentation_disabled,
         resume_args_template,
         session_id_capture_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ws-1',
      'agent-1',
      process.execPath,
      '{bad json',
      null,
      null,
      0,
      null,
      null,
      Date.now(),
      Date.now()
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createAgentRunStore(db)
    const configs = store.listLaunchConfigs()

    expect(configs).toEqual([
      {
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        config: {
          command: process.execPath,
          args: [],
          commandPresetId: null,
          cwd: null,
          interactiveCommand: null,
          presetAugmentationDisabled: false,
          resumeArgsTemplate: null,
          sessionIdCapture: null,
        },
      },
    ])
    expect(warnSpy).toHaveBeenCalled()

    db.close()
  })
})
