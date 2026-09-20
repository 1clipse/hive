import { describe, expect, test } from 'vitest'

import { BadRequestError } from '../../src/server/http-errors.js'
import {
  listAvailableBuiltinCliIds,
  resolveDefaultSpawnCliLaunchConfig,
  resolveExplicitSpawnCliLaunchConfig,
  type SpawnCliPresetRecord,
  type SpawnCliResolverPorts,
} from '../../src/server/spawn-cli-resolver.js'

const makePreset = (id: string, command = id): SpawnCliPresetRecord => ({
  args: [`--yolo-${id}`],
  command,
  env: {},
  id,
})

const BUILTIN_LIKE_PRESETS: SpawnCliPresetRecord[] = [
  makePreset('claude'),
  makePreset('codex'),
  makePreset('opencode'),
  makePreset('gemini'),
  makePreset('pi'),
  makePreset('cursor', 'cursor-agent'),
]

const makePorts = ({
  availableCommands,
  orchestratorConfig,
  presets = BUILTIN_LIKE_PRESETS,
}: {
  availableCommands: string[]
  orchestratorConfig?: ReturnType<SpawnCliResolverPorts['getOrchestratorLaunchConfig']>
  presets?: SpawnCliPresetRecord[]
}): SpawnCliResolverPorts => ({
  getCommandPreset: (id) => presets.find((preset) => preset.id === id),
  getOrchestratorLaunchConfig: () => orchestratorConfig,
  isCommandAvailable: (command) => availableCommands.includes(command),
})

describe('resolveDefaultSpawnCliLaunchConfig (team spawn without --cli)', () => {
  test('inherits the orchestrator preset id instead of defaulting to claude', () => {
    const ports = makePorts({
      availableCommands: ['claude', 'codex'],
      orchestratorConfig: { command: 'codex', commandPresetId: 'codex' },
    })
    const config = resolveDefaultSpawnCliLaunchConfig(ports)
    expect(config.commandPresetId).toBe('codex')
    expect(config.command).toBe('codex')
    expect(config.args).toEqual(['--yolo-codex'])
  })

  test('inherits the orchestrator brand by normalizing its command when no preset id is set', () => {
    const ports = makePorts({
      availableCommands: ['claude', 'codex'],
      orchestratorConfig: { command: '/usr/local/bin/codex', commandPresetId: null },
    })
    expect(resolveDefaultSpawnCliLaunchConfig(ports).commandPresetId).toBe('codex')
  })

  test('maps a brand command back to its preset id (cursor-agent -> cursor)', () => {
    const ports = makePorts({
      availableCommands: ['claude', 'cursor-agent'],
      orchestratorConfig: { command: 'cursor-agent', commandPresetId: null },
    })
    const config = resolveDefaultSpawnCliLaunchConfig(ports)
    expect(config.commandPresetId).toBe('cursor')
    expect(config.command).toBe('cursor-agent')
  })

  test('prefers interactiveCommand over the shell wrapper of a startup-command launch', () => {
    const ports = makePorts({
      availableCommands: ['gemini'],
      orchestratorConfig: {
        command: '/bin/zsh',
        commandPresetId: null,
        interactiveCommand: 'gemini',
      },
    })
    expect(resolveDefaultSpawnCliLaunchConfig(ports).commandPresetId).toBe('gemini')
  })

  test('falls back to the first PATH-available builtin when the orchestrator has no config', () => {
    const ports = makePorts({ availableCommands: ['gemini'] })
    const config = resolveDefaultSpawnCliLaunchConfig(ports)
    expect(config.commandPresetId).toBe('gemini')
    expect(config.args).toEqual(['--yolo-gemini'])
  })

  test('falls back to the first PATH-available builtin when the inherited CLI is not on PATH', () => {
    const ports = makePorts({
      availableCommands: ['opencode'],
      orchestratorConfig: { command: 'codex', commandPresetId: 'codex' },
    })
    expect(resolveDefaultSpawnCliLaunchConfig(ports).commandPresetId).toBe('opencode')
  })

  test('respects builtin order when several CLIs are available (codex before gemini)', () => {
    const ports = makePorts({ availableCommands: ['gemini', 'codex'] })
    expect(resolveDefaultSpawnCliLaunchConfig(ports).commandPresetId).toBe('codex')
  })

  test('can fall back to Pi when it is the first available builtin', () => {
    const ports = makePorts({ availableCommands: ['pi'] })
    const config = resolveDefaultSpawnCliLaunchConfig(ports)
    expect(config.commandPresetId).toBe('pi')
    expect(config.command).toBe('pi')
  })

  test('keeps the historical claude fallback when nothing is available at all', () => {
    const ports = makePorts({ availableCommands: [] })
    const config = resolveDefaultSpawnCliLaunchConfig(ports)
    expect(config.commandPresetId).toBe('claude')
    expect(config.command).toBe('claude')
  })

  test('falls back to a bare claude launch when even the claude preset row is missing', () => {
    const ports = makePorts({ availableCommands: [], presets: [] })
    expect(resolveDefaultSpawnCliLaunchConfig(ports)).toEqual({ args: [], command: 'claude' })
  })
})

describe('resolveExplicitSpawnCliLaunchConfig (team spawn --cli <id>)', () => {
  test('returns the launch config for an available explicit cli', () => {
    const ports = makePorts({ availableCommands: ['codex'] })
    const config = resolveExplicitSpawnCliLaunchConfig(ports, 'codex')
    expect(config).toEqual({ args: ['--yolo-codex'], command: 'codex', commandPresetId: 'codex' })
  })

  test('rejects an explicit cli whose command is missing from PATH with a 400 + suggestion', () => {
    const ports = makePorts({ availableCommands: ['gemini'] })
    let caught: unknown
    try {
      resolveExplicitSpawnCliLaunchConfig(ports, 'claude')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BadRequestError)
    const message = (caught as BadRequestError).message
    expect((caught as BadRequestError).statusCode).toBe(400)
    expect(message).toContain("'claude'")
    expect(message).toContain('PATH')
    expect(message).toContain('--cli gemini')
  })

  test('rejects an unavailable explicit cli with install-only advice when nothing else is available', () => {
    const ports = makePorts({ availableCommands: [] })
    let caught: unknown
    try {
      resolveExplicitSpawnCliLaunchConfig(ports, 'codex')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BadRequestError)
    expect((caught as BadRequestError).message).toContain('Install it')
    expect((caught as BadRequestError).message).not.toContain('--cli ')
  })

  test('rejects an unknown cli id', () => {
    const ports = makePorts({ availableCommands: ['claude'] })
    expect(() => resolveExplicitSpawnCliLaunchConfig(ports, 'not-a-cli')).toThrowError(
      "Unsupported cli 'not-a-cli'"
    )
  })
})

describe('listAvailableBuiltinCliIds', () => {
  test('lists only builtins whose command probes as available, in builtin order', () => {
    const ports = makePorts({ availableCommands: ['cursor-agent', 'pi', 'codex'] })
    expect(listAvailableBuiltinCliIds(ports)).toEqual(['codex', 'pi', 'cursor'])
  })
})
