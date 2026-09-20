import { spawn } from 'node:child_process'
import { mergeProcessEnv, resolveChildProcessSpawnCommand } from './agent-command-resolver.js'
import { taskkillProcessTree } from './agent-manager-support.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { normalizeExecutableToken } from './startup-command-parser.js'
import { extractJsonBlock } from './workflow-output-schema.js'

const DEFAULT_DREAM_CLI_COMMAND = 'claude'
const DEFAULT_DREAM_CLI_ARGS = ['--print']
const DEFAULT_DREAM_CLI_TIMEOUT_MS = 2 * 60 * 1000
const MAX_DREAM_CLI_OUTPUT_CHARS = 200_000

const HEADLESS_ARGS_BY_CLI: Record<string, string[]> = {
  claude: ['--print'],
  codex: ['exec', '--sandbox', 'read-only', '-'],
}

interface DreamCommandPreset {
  command: string
  env: Record<string, string>
  id: string
}

export interface DreamCliConfig {
  args: string[]
  command: string
  env: Record<string, string>
  timeoutMs: number
}

export interface DreamCliExecutor {
  execute: (input: {
    cwd: string
    getCommandPreset: (id: string) => DreamCommandPreset | undefined
    orchestratorLaunchConfig: AgentLaunchConfigInput | undefined
    prompt: string
  }) => Promise<unknown>
}

export class UnsupportedDreamCliError extends Error {
  readonly code = 'UNSUPPORTED_DREAM_CLI'

  constructor(readonly cli: string) {
    super(
      `Scheduled Dream does not support orchestrator CLI '${cli}'; configure HIVE_MEMORY_DREAM_COMMAND and HIVE_MEMORY_DREAM_ARGS_JSON explicitly`
    )
    this.name = 'UnsupportedDreamCliError'
  }
}

const parseArgsJson = (raw: string): string[] => {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('HIVE_MEMORY_DREAM_ARGS_JSON must be a JSON array of strings')
  }
  return parsed
}

const parseTimeoutMs = (raw: string | undefined) => {
  if (!raw) return DEFAULT_DREAM_CLI_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('HIVE_MEMORY_DREAM_TIMEOUT_MS must be a positive number')
  }
  return Math.trunc(parsed)
}

export const readDreamCliConfig = (env: NodeJS.ProcessEnv = process.env): DreamCliConfig => ({
  args:
    env.HIVE_MEMORY_DREAM_ARGS_JSON !== undefined
      ? parseArgsJson(env.HIVE_MEMORY_DREAM_ARGS_JSON)
      : (HEADLESS_ARGS_BY_CLI[
          normalizeExecutableToken(env.HIVE_MEMORY_DREAM_COMMAND) ?? DEFAULT_DREAM_CLI_COMMAND
        ] ?? DEFAULT_DREAM_CLI_ARGS),
  command: env.HIVE_MEMORY_DREAM_COMMAND?.trim() || DEFAULT_DREAM_CLI_COMMAND,
  env: {},
  timeoutMs: parseTimeoutMs(env.HIVE_MEMORY_DREAM_TIMEOUT_MS),
})

export const resolveDreamCliConfig = (input: {
  env?: NodeJS.ProcessEnv
  getCommandPreset: (id: string) => DreamCommandPreset | undefined
  orchestratorLaunchConfig: AgentLaunchConfigInput | undefined
}): DreamCliConfig => {
  const env = input.env ?? process.env
  if (env.HIVE_MEMORY_DREAM_COMMAND?.trim()) return readDreamCliConfig(env)

  const launch = input.orchestratorLaunchConfig
  if (!launch) {
    throw new Error(
      'Scheduled Dream cannot resolve the workspace orchestrator CLI because its launch configuration is missing'
    )
  }

  const configuredPreset = launch.commandPresetId
    ? input.getCommandPreset(launch.commandPresetId)
    : undefined
  const executable = configuredPreset?.command ?? launch.interactiveCommand ?? launch.command
  const cli = normalizeExecutableToken(executable)
  const args = cli ? HEADLESS_ARGS_BY_CLI[cli] : undefined
  if (!cli || !args) {
    throw new UnsupportedDreamCliError(cli ?? executable)
  }
  const preset = configuredPreset ?? input.getCommandPreset(cli)
  return {
    args:
      env.HIVE_MEMORY_DREAM_ARGS_JSON !== undefined
        ? parseArgsJson(env.HIVE_MEMORY_DREAM_ARGS_JSON)
        : [...args],
    command: preset?.command ?? executable,
    env: preset?.env ?? {},
    timeoutMs: parseTimeoutMs(env.HIVE_MEMORY_DREAM_TIMEOUT_MS),
  }
}

export const resolveDreamSpawnCommand = (input: {
  config: DreamCliConfig
  cwd: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): { args: string[]; command: string } => {
  return resolveChildProcessSpawnCommand(
    input.config.command,
    input.cwd,
    input.env,
    input.config.args,
    input.platform
  )
}

const appendLimited = (current: string, chunk: string) =>
  current.length >= MAX_DREAM_CLI_OUTPUT_CHARS
    ? current
    : `${current}${chunk}`.slice(0, MAX_DREAM_CLI_OUTPUT_CHARS)

const parseDreamCliOutput = (stdout: string) => {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('Dream CLI returned empty output')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    const fenced = extractJsonBlock(trimmed)
    if (!fenced) throw new Error('Dream CLI output was not valid JSON')
    parsed = fenced
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Dream CLI output must be a JSON object')
  }
  const ops = (parsed as { ops?: unknown }).ops
  if (!Array.isArray(ops)) throw new Error('Dream CLI output ops must be an array')
  return ops
}

export const createDreamCliExecutor = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): DreamCliExecutor => ({
  execute({ cwd, getCommandPreset, orchestratorLaunchConfig, prompt }) {
    return new Promise((resolve, reject) => {
      const config = resolveDreamCliConfig({ env, getCommandPreset, orchestratorLaunchConfig })
      const childEnv = mergeProcessEnv(
        env,
        { ...config.env, NO_COLOR: env.NO_COLOR ?? '1' },
        platform
      )
      const resolved = resolveDreamSpawnCommand({ config, cwd, env: childEnv, platform })
      const child = spawn(resolved.command, resolved.args, {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const killChild = () => child.kill('SIGTERM')
        if (!taskkillProcessTree(child.pid ?? 0, platform, undefined, killChild)) killChild()
        reject(new Error(`Dream CLI timed out after ${config.timeoutMs}ms`))
      }, config.timeoutMs)
      timer.unref?.()

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout = appendLimited(stdout, chunk)
      })
      child.stderr.on('data', (chunk: string) => {
        stderr = appendLimited(stderr, chunk)
      })
      child.stdin.on('error', (error) => {
        settle(() => reject(error))
      })
      child.on('error', (error) => {
        settle(() => reject(error))
      })
      child.on('close', (code, signal) => {
        settle(() => {
          if (code !== 0) {
            const reason = signal
              ? `Dream CLI exited by signal ${signal}`
              : `Dream CLI exited with code ${code ?? 'unknown'}`
            reject(new Error(stderr.trim() ? `${reason}: ${stderr.trim()}` : reason))
            return
          }
          try {
            resolve(parseDreamCliOutput(stdout))
          } catch (error) {
            reject(error)
          }
        })
      })
      child.stdin.end(prompt)
    })
  },
})
