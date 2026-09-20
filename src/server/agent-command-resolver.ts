import { accessSync, constants } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join } from 'node:path'

import { buildCmdCallCommand } from './windows-command-line.js'

const hasPathSeparator = (command: string) => command.includes('/') || command.includes('\\')

const canExecute = (path: string, platform = process.platform): boolean => {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

const createCommandNotFoundError = (command: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${command} CLI not found in PATH`), {
    code: 'ENOENT',
    path: command,
  })

interface ResolvedSpawnCommand {
  /**
   * `args` is a `string[]` for plain executables (node-pty's serializer is
   * fine for them) and a verbatim `string` for Windows `.cmd`/`.bat` shim
   * launches. The verbatim form bypasses node-pty's `argsToCommandLine`,
   * because that function backslash-escapes any embedded `"` and cmd.exe
   * does NOT recognize `\"` as an escape — it treats `\` as literal, which
   * leaves cmd looking up a program name containing literal quote chars.
   * See `node-pty/src/windowsPtyAgent.ts` `argsToCommandLine` for the rule.
   */
  args: string | string[]
  command: string
}

const getEnvValue = (
  env: NodeJS.ProcessEnv,
  key: string,
  platform = process.platform
): string | undefined => {
  if (platform !== 'win32') return env[key]
  if (Object.hasOwn(env, key)) return env[key]
  const matchedKey = Object.keys(env)
    .filter((item) => item.toLowerCase() === key.toLowerCase())
    .at(-1)
  return matchedKey ? env[matchedKey] : undefined
}

const getWindowsExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] => {
  if (extname(command)) return [command]

  const extensions = (getEnvValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
  return extensions.map((extension) => `${command}${extension}`)
}

const getExecutableNames = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] =>
  platform === 'win32' ? getWindowsExecutableNames(command, env, platform) : [command]

export const resolveCommandPath = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string => {
  if (hasPathSeparator(command)) {
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = isAbsolute(name) ? name : join(cwd, name)
      if (canExecute(candidate, platform)) return candidate
    }
    throw createCommandNotFoundError(command)
  }

  for (const pathEntry of (getEnvValue(env, 'PATH', platform) ?? '').split(delimiter)) {
    if (!pathEntry) continue
    for (const name of getExecutableNames(command, env, platform)) {
      const candidate = join(pathEntry, name)
      if (canExecute(candidate, platform)) return candidate
    }
  }

  throw createCommandNotFoundError(command)
}

const isWindowsBatchFile = (command: string) => {
  const extension = extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

const buildWindowsBatchCommandLine = (command: string, args: string[]) => {
  // `call` is cmd's built-in batch invocation; it handles quoted .cmd / .bat
  // paths reliably (this is the same pattern Node.js's child_process uses
  // internally on Windows since the CVE-2024-27980 fix).
  // Most Windows agent CLIs are npm .cmd shims. Set the console code page to
  // UTF-8 before launching them so Hive's injected CJK startup guidance is not
  // interpreted through the machine's OEM code page.
  return `/d /s /c chcp 65001 >nul && ${buildCmdCallCommand(command, args)}`
}

export const mergeProcessEnv = (
  parent: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => {
  if (platform !== 'win32') return { ...parent, ...overlay }
  const merged = { ...parent }
  for (const [key, value] of Object.entries(overlay)) {
    for (const existingKey of Object.keys(merged)) {
      if (existingKey.toLowerCase() === key.toLowerCase()) delete merged[existingKey]
    }
    merged[key] = value
  }
  return merged
}

export const resolveChildProcessSpawnCommand = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  platform = process.platform
): { args: string[]; command: string } => {
  const resolvedCommand = resolveCommandPath(command, cwd, env, platform)
  if (platform === 'win32' && isWindowsBatchFile(resolvedCommand)) {
    return {
      args: ['/d', '/s', '/c', `chcp 65001 >nul && ${buildCmdCallCommand(resolvedCommand, args)}`],
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }
  return { args, command: resolvedCommand }
}

/**
 * Recognize the exact shape that `createStartupCommandLaunch` produces on
 * Windows: `cmd.exe` with args `['/d', '/s', '/c', '<raw user command>']`.
 * Pinned to length 4 so this branch only fires for that single contract;
 * any other cmd.exe invocation (e.g. someone explicitly composing custom
 * shell args via the launch config) keeps the default node-pty path.
 *
 * We need this repackaging because the user's raw command often contains `"`
 * (Windows users habitually wrap paths) and node-pty's `argsToCommandLine`
 * backslash-escapes those — cmd.exe then sees `\"...\"` and looks up a
 * program whose name starts with `\`.
 */
const isCmdExeShellLaunch = (resolvedCommand: string, args: string[]): boolean =>
  basename(resolvedCommand).toLowerCase() === 'cmd.exe' &&
  args.length === 4 &&
  args[0] === '/d' &&
  args[1] === '/s' &&
  (args[2] === '/c' || args[2] === '/k')

export const resolveSpawnCommand = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  platform = process.platform
): ResolvedSpawnCommand => {
  const resolvedCommand = resolveCommandPath(command, cwd, env, platform)
  if (platform === 'win32' && isWindowsBatchFile(resolvedCommand)) {
    return {
      args: buildWindowsBatchCommandLine(resolvedCommand, args),
      command: getEnvValue(env, 'ComSpec', platform) ?? 'cmd.exe',
    }
  }
  if (platform === 'win32' && isCmdExeShellLaunch(resolvedCommand, args)) {
    return {
      args: args.join(' '),
      command: resolvedCommand,
    }
  }
  return { args, command: resolvedCommand }
}

export const assertCommandIsExecutable = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): void => {
  resolveCommandPath(command, cwd, env)
}

/**
 * PATH-availability probe shared by Settings preset serialization and
 * `team spawn` CLI selection. True when `command` resolves to an executable
 * with the preset's env overlayed on the current process env. Never throws.
 */
export const isCommandAvailableOnPath = (
  command: string,
  env: Record<string, string> = {}
): boolean => {
  if (!command.trim()) return false
  try {
    resolveCommandPath(command, process.cwd(), { ...process.env, ...env })
    return true
  } catch {
    return false
  }
}

export type { ResolvedSpawnCommand }
