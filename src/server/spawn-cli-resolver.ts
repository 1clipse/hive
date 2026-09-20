import { isCommandAvailableOnPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import {
  BUILTIN_COMMAND_PRESET_IDS,
  getBuiltinCommandPresetByCommand,
} from './command-preset-defaults.js'
import { BadRequestError } from './http-errors.js'
import { normalizeExecutableToken } from './startup-command-parser.js'

/**
 * CLI selection for `team spawn` (growth research 2026-06-11, P0-B2).
 *
 * The old behavior hardcoded the default to 'claude': a Codex/Gemini-only
 * user whose orchestrator asked for `team spawn coder` got a worker that
 * died instantly on a missing `claude` binary. The default now:
 *   1. inherits the workspace orchestrator's CLI brand (preset id first,
 *      else the brand normalized from its launch command), if available;
 *   2. else picks the first built-in preset whose command is on PATH;
 *   3. else falls back to 'claude' as the last resort (old behavior).
 * An EXPLICIT `--cli` that is not on PATH is now a 400 with a suggestion
 * instead of a silently-broken worker.
 *
 * The PATH probe is injectable so unit tests never touch the real PATH.
 */

export interface SpawnCliPresetRecord {
  id: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type CliAvailabilityProbe = (command: string, env: Record<string, string>) => boolean

export interface SpawnCliResolverPorts {
  /** Settings lookup — covers built-in presets (possibly user-edited) and custom ones. */
  getCommandPreset: (id: string) => SpawnCliPresetRecord | undefined
  /** Launch config of this workspace's orchestrator, if it was ever configured. */
  getOrchestratorLaunchConfig: () =>
    | Pick<AgentLaunchConfigInput, 'command' | 'commandPresetId' | 'interactiveCommand'>
    | undefined
  /** PATH probe — defaults to the real probe; tests inject a stub. */
  isCommandAvailable?: CliAvailabilityProbe
}

const toLaunchConfig = (preset: SpawnCliPresetRecord): AgentLaunchConfigInput => ({
  args: preset.args,
  command: preset.command,
  commandPresetId: preset.id,
})

const getProbe = (ports: SpawnCliResolverPorts): CliAvailabilityProbe =>
  ports.isCommandAvailable ?? isCommandAvailableOnPath

const getAvailablePreset = (
  ports: SpawnCliResolverPorts,
  presetId: string
): SpawnCliPresetRecord | undefined => {
  const preset = ports.getCommandPreset(presetId)
  if (!preset) return undefined
  return getProbe(ports)(preset.command, preset.env) ? preset : undefined
}

/**
 * The orchestrator's CLI brand: explicit preset id when the launch config
 * carries one, else the brand normalized from the launch command (for
 * startup-command launches the shell is in `command` and the real CLI in
 * `interactiveCommand`, so prefer the latter). `cursor-agent`-style commands
 * map back to their preset id via the built-in command table.
 */
const inheritedOrchestratorPresetId = (ports: SpawnCliResolverPorts): string | undefined => {
  const config = ports.getOrchestratorLaunchConfig()
  if (!config) return undefined
  if (config.commandPresetId) return config.commandPresetId
  const brand = normalizeExecutableToken(config.interactiveCommand ?? config.command)
  if (!brand) return undefined
  return getBuiltinCommandPresetByCommand(brand)?.id ?? brand
}

/** Built-in preset ids whose command is actually visible on PATH, in built-in order. */
export const listAvailableBuiltinCliIds = (ports: SpawnCliResolverPorts): string[] =>
  BUILTIN_COMMAND_PRESET_IDS.filter((id) => getAvailablePreset(ports, id) !== undefined)

/** Default-CLI selection when `team spawn` omits `--cli`. */
export const resolveDefaultSpawnCliLaunchConfig = (
  ports: SpawnCliResolverPorts
): AgentLaunchConfigInput => {
  const inheritedId = inheritedOrchestratorPresetId(ports)
  if (inheritedId) {
    const inherited = getAvailablePreset(ports, inheritedId)
    if (inherited) return toLaunchConfig(inherited)
  }
  for (const id of BUILTIN_COMMAND_PRESET_IDS) {
    const preset = getAvailablePreset(ports, id)
    if (preset) return toLaunchConfig(preset)
  }
  // Last resort: nothing probed as available (or probing is impossible in
  // this environment) — keep the historical 'claude' fallback so spawn never
  // hard-fails on the default path.
  const claude = ports.getCommandPreset('claude')
  return claude ? toLaunchConfig(claude) : { args: [], command: 'claude' }
}

/** Explicit `--cli <id>`: unknown id or a command missing from PATH is a 400. */
export const resolveExplicitSpawnCliLaunchConfig = (
  ports: SpawnCliResolverPorts,
  cliId: string
): AgentLaunchConfigInput => {
  const preset = ports.getCommandPreset(cliId)
  if (!preset) {
    throw new BadRequestError(`Unsupported cli '${cliId}'`)
  }
  if (!getProbe(ports)(preset.command, preset.env)) {
    const available = listAvailableBuiltinCliIds(ports)
    const hint =
      available.length > 0
        ? `Install it, or retry with a CLI that is available on this machine: \`team spawn <role> --cli ${available[0]}\` (available: ${available.join(', ')}).`
        : 'Install it and make sure it is on PATH, then retry.'
    throw new BadRequestError(
      `CLI '${cliId}' is not usable here: its command '${preset.command}' is not visible on PATH. ${hint}`
    )
  }
  return toLaunchConfig(preset)
}
