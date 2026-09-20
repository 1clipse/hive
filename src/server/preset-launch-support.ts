import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SessionCaptureSnapshot, SessionIdCaptureConfig } from './session-capture.js'
import { doesCapturedSessionExist } from './session-capture.js'
import { getStartupCommandExecutable, normalizeExecutableToken } from './startup-command-parser.js'

type BoundPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
> &
  Partial<Pick<CommandPresetRecord, 'command' | 'id'>>

const appendUniqueArgs = (prefix: string[], args: string[]) => {
  const seen = new Set(prefix)
  return prefix.concat(args.filter((arg) => !seen.has(arg)))
}

const unquoteExecutable = (command: string) => command.trim().replace(/^"(.+)"$/, '$1')

const isNodeExecutable = (command: string | null | undefined) => {
  if (!command) return false
  return /(?:^|[\\/])node(?:\.exe)?$/iu.test(unquoteExecutable(command))
}

const isCodexNpmEntrypoint = (arg: string | undefined) => {
  if (!arg) return false
  const normalized = arg.replace(/\\/gu, '/')
  return /(?:^|\/)@openai\/codex\/bin\/codex\.js$/iu.test(normalized)
}

const isCodexPreset = (preset: BoundPreset | null | undefined) =>
  preset?.id === 'codex' ||
  preset?.command === 'codex' ||
  preset?.sessionIdCapture?.source === 'codex_session_jsonl_dir'

const normalizeCodexNodeEntrypoint = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => {
  if (!isCodexPreset(preset) || !isNodeExecutable(config.command)) return config
  const args = config.args ?? []
  if (!isCodexNpmEntrypoint(args[0])) return config

  return {
    ...config,
    args: args.slice(1),
    command: preset?.command ?? 'codex',
    interactiveCommand: isNodeExecutable(config.interactiveCommand)
      ? 'codex'
      : (config.interactiveCommand ?? 'codex'),
  } satisfies AgentLaunchConfigInput
}

const getEffectiveCapture = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.sessionIdCapture ?? preset?.sessionIdCapture ?? null

const getEffectiveResumeTemplate = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.resumeArgsTemplate ?? preset?.resumeArgsTemplate ?? null

const withPresetYoloArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => {
  const yoloArgs = preset?.yoloArgsTemplate
  if (!yoloArgs?.length) return config
  const nextArgs = appendUniqueArgs(yoloArgs, config.args ?? [])
  if (
    nextArgs.length === (config.args ?? []).length &&
    nextArgs.every((arg, index) => arg === (config.args ?? [])[index])
  ) {
    return config
  }
  return { ...config, args: nextArgs }
}

const getPresetYoloArgs = (preset: BoundPreset | null | undefined) => preset?.yoloArgsTemplate ?? []

export const hasResumeLaunchArgs = (args: readonly string[]) =>
  args.includes('--resume') ||
  args.includes('-r') ||
  args.includes('--continue') ||
  args.includes('-c') ||
  args.includes('--session') ||
  args.includes('-s') ||
  args[0] === 'resume'

const splitShellCommand = (command: string) => {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

const getShellCommandArg = (args: readonly string[]) => {
  const commandFlagIndex = args.findIndex(
    (arg) => arg === '-c' || arg === '-ic' || arg === '-lc' || arg === '-lic'
  )
  if (commandFlagIndex >= 0) return args[commandFlagIndex + 1]
  const windowsCommandIndex = args.findIndex((arg) => arg.toLowerCase() === '/c')
  return windowsCommandIndex >= 0 ? args[windowsCommandIndex + 1] : undefined
}

const isResumeShellCommand = (
  config: Pick<AgentLaunchConfigInput, 'args' | 'command' | 'interactiveCommand'>
) => {
  const shellCommand = getShellCommandArg(config.args ?? [])
  if (!shellCommand) return false
  const executable = normalizeExecutableToken(getStartupCommandExecutable(shellCommand))
  const interactiveCommand = normalizeExecutableToken(config.interactiveCommand ?? config.command)
  if (executable && interactiveCommand && executable !== interactiveCommand) return false
  const [, ...args] = splitShellCommand(shellCommand)
  return hasResumeLaunchArgs(args)
}

export const isResumeLaunchConfig = (
  config: Pick<
    AgentLaunchConfigInput,
    'args' | 'command' | 'interactiveCommand' | 'resumedSessionId'
  >
) =>
  Boolean(config.resumedSessionId) ||
  hasResumeLaunchArgs(config.args ?? []) ||
  isResumeShellCommand(config)

const shouldVerifySessionBeforeResume = (capture: SessionIdCaptureConfig | null | undefined) => {
  // Claude is a cheap project-dir existence check; OpenCode is a direct DB query.
  // Codex/Gemini require broad session-store scans, so trust the persisted id and
  // let the CLI fail fast if it is stale.
  return capture?.source === 'claude_project_jsonl_dir' || capture?.source === 'opencode_session_db'
}

const supportsPresetResume = (capture: SessionIdCaptureConfig | null | undefined) =>
  capture?.source === 'claude_project_jsonl_dir' ||
  capture?.source === 'codex_session_jsonl_dir' ||
  capture?.source === 'gemini_session_json_dir' ||
  capture?.source === 'opencode_session_db' ||
  capture?.source === 'qwen_session_json_dir' ||
  capture?.source === 'stdout_regex'

export const withPresetResumeArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined,
  lastSessionId: string | undefined,
  cwd?: string,
  discriminator?: SessionCaptureSnapshot['discriminator'],
  onInvalidSessionId?: (sessionId: string) => void
) => {
  const launchConfig = normalizeCodexNodeEntrypoint(config, preset)
  let nextConfig = withPresetYoloArgs(launchConfig, preset)
  const sessionIdCapture = getEffectiveCapture(nextConfig, preset)
  if (sessionIdCapture && sessionIdCapture !== nextConfig.sessionIdCapture) {
    nextConfig = { ...nextConfig, sessionIdCapture }
  }

  const resumeArgsTemplate = getEffectiveResumeTemplate(nextConfig, preset)
  if (!lastSessionId || !resumeArgsTemplate) return nextConfig
  if (sessionIdCapture && !supportsPresetResume(sessionIdCapture)) return nextConfig
  if (
    cwd &&
    sessionIdCapture &&
    shouldVerifySessionBeforeResume(sessionIdCapture) &&
    !doesCapturedSessionExist(cwd, sessionIdCapture, lastSessionId, discriminator)
  ) {
    onInvalidSessionId?.(lastSessionId)
    return nextConfig
  }
  const args = launchConfig.args ?? []
  if (hasResumeLaunchArgs(args)) return nextConfig
  const yoloArgs = getPresetYoloArgs(preset)
  const resumeArgs = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim().split(/\s+/)

  return {
    ...nextConfig,
    args: appendUniqueArgs(yoloArgs, resumeArgs.concat(args)),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}
