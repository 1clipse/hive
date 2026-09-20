import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createDreamCliExecutor,
  resolveDreamCliConfig,
  resolveDreamSpawnCommand,
  UnsupportedDreamCliError,
} from '../../src/server/team-memory-dream-cli.js'

const preset = (id: string, command = id) => ({
  command,
  env: {},
  id,
})

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('resolveDreamCliConfig', () => {
  test('uses the workspace Codex orchestrator for scheduled Dream runs', () => {
    const config = resolveDreamCliConfig({
      env: {},
      getCommandPreset: (id) => (id === 'codex' ? preset('codex') : undefined),
      orchestratorLaunchConfig: {
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        command: 'codex',
        commandPresetId: 'codex',
      },
    })

    expect(config).toEqual({
      args: ['exec', '--sandbox', 'read-only', '-'],
      command: 'codex',
      env: {},
      timeoutMs: 120_000,
    })
  })

  test('uses the workspace Claude orchestrator for scheduled Dream runs', () => {
    const config = resolveDreamCliConfig({
      env: {},
      getCommandPreset: (id) => (id === 'claude' ? preset('claude') : undefined),
      orchestratorLaunchConfig: {
        args: ['--dangerously-skip-permissions'],
        command: 'claude',
        commandPresetId: 'claude',
      },
    })

    expect(config).toEqual({
      args: ['--print'],
      command: 'claude',
      env: {},
      timeoutMs: 120_000,
    })
  })

  test('recognizes a Codex startup command wrapped by the Windows shell', () => {
    const config = resolveDreamCliConfig({
      env: {},
      getCommandPreset: (id) => (id === 'codex' ? preset('codex') : undefined),
      orchestratorLaunchConfig: {
        args: ['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\codex.cmd"'],
        command: 'cmd.exe',
        commandPresetId: null,
        interactiveCommand: 'codex',
        presetAugmentationDisabled: true,
      },
    })

    expect(config.command).toBe('codex')
    expect(config.args).toEqual(['exec', '--sandbox', 'read-only', '-'])
  })

  test('keeps the explicit Dream CLI environment override above workspace inheritance', () => {
    const config = resolveDreamCliConfig({
      env: {
        HIVE_MEMORY_DREAM_ARGS_JSON: '["--batch"]',
        HIVE_MEMORY_DREAM_COMMAND: 'custom-dream',
        HIVE_MEMORY_DREAM_TIMEOUT_MS: '45000',
      },
      getCommandPreset: () => undefined,
      orchestratorLaunchConfig: {
        command: 'codex',
        commandPresetId: 'codex',
      },
    })

    expect(config).toEqual({
      args: ['--batch'],
      command: 'custom-dream',
      env: {},
      timeoutMs: 45_000,
    })
  })

  test('derives Codex headless args when only the Dream command is overridden', () => {
    const config = resolveDreamCliConfig({
      env: { HIVE_MEMORY_DREAM_COMMAND: 'codex' },
      getCommandPreset: () => undefined,
      orchestratorLaunchConfig: undefined,
    })

    expect(config.args).toEqual(['exec', '--sandbox', 'read-only', '-'])
    expect(config.command).toBe('codex')
  })

  test('applies an args-only override to the inherited orchestrator command', () => {
    const config = resolveDreamCliConfig({
      env: { HIVE_MEMORY_DREAM_ARGS_JSON: '["exec","--ephemeral","-"]' },
      getCommandPreset: (id) => (id === 'codex' ? preset('codex') : undefined),
      orchestratorLaunchConfig: { command: 'codex', commandPresetId: 'codex' },
    })

    expect(config.args).toEqual(['exec', '--ephemeral', '-'])
    expect(config.command).toBe('codex')
  })

  test('fails clearly instead of silently switching an unsupported orchestrator to Claude', () => {
    let caught: unknown
    try {
      resolveDreamCliConfig({
        env: {},
        getCommandPreset: () => undefined,
        orchestratorLaunchConfig: {
          args: [],
          command: 'my-agent',
          commandPresetId: null,
        },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnsupportedDreamCliError)
    expect(caught).toMatchObject({ cli: 'my-agent', code: 'UNSUPPORTED_DREAM_CLI' })
  })

  test('wraps an npm .cmd shim with cmd.exe for Windows child-process execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-dream-command-'))
    tempDirs.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const codexCmd = join(bin, 'codex.cmd')
    writeFileSync(codexCmd, '@echo off\r\n')

    const resolved = resolveDreamSpawnCommand({
      config: {
        args: ['exec', '--sandbox', 'read-only', '-'],
        command: 'codex',
        env: {},
        timeoutMs: 120_000,
      },
      cwd: root,
      env: {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        Path: bin,
        PathExt: '.cmd;.EXE',
      },
      platform: 'win32',
    })

    expect(resolved).toEqual({
      args: ['/d', '/s', '/c', `chcp 65001 >nul && call ${codexCmd} exec --sandbox read-only -`],
      command: 'C:\\Windows\\System32\\cmd.exe',
    })
  })

  test('rejects instead of crashing when the Dream CLI closes while stdin is still writing', async () => {
    const executor = createDreamCliExecutor({
      HIVE_MEMORY_DREAM_ARGS_JSON: '["-e","process.exit(3)"]',
      HIVE_MEMORY_DREAM_COMMAND: process.execPath,
      HIVE_MEMORY_DREAM_TIMEOUT_MS: '5000',
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
    })

    await expect(
      executor.execute({
        cwd: process.cwd(),
        getCommandPreset: () => undefined,
        orchestratorLaunchConfig: undefined,
        prompt: 'x'.repeat(10 * 1024 * 1024),
      })
    ).rejects.toBeInstanceOf(Error)
  })
})
