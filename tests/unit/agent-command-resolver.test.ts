import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  assertCommandIsExecutable,
  mergeProcessEnv,
  resolveCommandPath,
  resolveSpawnCommand,
} from '../../src/server/agent-command-resolver.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

/**
 * Faithful TypeScript port of node-pty's `argsToCommandLine` (see
 * `node_modules/node-pty/src/windowsPtyAgent.ts`). Tests assert against the
 * string that node-pty would actually hand to CreateProcess on Windows, not
 * against the array Hive hands to node-pty — because the bug we're fixing is
 * a corruption of that handoff. Inlined rather than deep-imported so this
 * test doesn't lock against node-pty's internal file layout.
 *
 * If node-pty changes its serialization, this fixture must be updated to match
 * (and the fix re-verified). The intent of the test is "what cmd.exe will
 * actually receive," and that string IS the contract.
 */
const repeat = (s: string, n: number) => (n <= 0 ? '' : s.repeat(n))

const simulateNodePtyCommandLine = (file: string, args: string | string[]): string => {
  if (typeof args === 'string') {
    return args.length === 0 ? file : `${simulateNodePtyCommandLine(file, [])} ${args}`
  }
  const argv = [file, ...args]
  let result = ''
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argIndex > 0) result += ' '
    const arg = argv[argIndex] ?? ''
    const hasLopsidedEnclosingQuote = (arg[0] !== '"') !== (arg[arg.length - 1] !== '"')
    const hasNoEnclosingQuotes = arg[0] !== '"' && arg[arg.length - 1] !== '"'
    const quote =
      arg === '' ||
      ((arg.indexOf(' ') !== -1 || arg.indexOf('\t') !== -1) &&
        arg.length > 1 &&
        (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes))
    if (quote) result += '"'
    let bsCount = 0
    for (let i = 0; i < arg.length; i++) {
      const p = arg[i]
      if (p === '\\') {
        bsCount++
      } else if (p === '"') {
        result += repeat('\\', bsCount * 2 + 1)
        result += '"'
        bsCount = 0
      } else {
        result += repeat('\\', bsCount)
        bsCount = 0
        result += p
      }
    }
    if (quote) {
      result += repeat('\\', bsCount * 2)
      result += '"'
    } else {
      result += repeat('\\', bsCount)
    }
  }
  return result
}

describe('agent command resolver', () => {
  test('merges Windows environment overlays without duplicate case-insensitive keys', () => {
    const merged = mergeProcessEnv(
      { Path: 'parent-bin', TEMP: 'parent-temp' },
      { PATH: 'preset-bin', temp: 'preset-temp' },
      'win32'
    )

    expect(merged).toEqual({ PATH: 'preset-bin', temp: 'preset-temp' })
  })

  test('accepts executable commands already present on PATH', () => {
    assertCommandIsExecutable(process.execPath, process.cwd(), process.env)
    expect(resolveCommandPath(process.execPath, process.cwd(), process.env)).toBe(process.execPath)
  })

  test('uses PATHEXT candidates before extensionless scripts on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), 'extensionless placeholder')
    writeFileSync(join(binDir, 'agent.cmd'), '@echo off\r\n')

    const resolved = resolveCommandPath(
      'agent',
      root,
      {
        Path: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        PathExt: '.cmd;.EXE',
      },
      'win32'
    )
    expect(resolved.toLowerCase()).toBe(join(binDir, 'agent.cmd').toLowerCase())
  })

  test('rejects extensionless PATH matches on Windows when PATHEXT has no candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-command-resolver-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'agent'), '#!/usr/bin/env bash\n')

    expect(() =>
      resolveCommandPath(
        'agent',
        root,
        {
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        'win32'
      )
    ).toThrow(/agent CLI not found in PATH/)
  })

  describe('Windows .cmd / .bat shim wrapping', () => {
    const createCmdShim = (name: string) => {
      const root = mkdtempSync(join(tmpdir(), 'hive-command-spawn-'))
      tempDirs.push(root)
      const binDir = join(root, 'bin')
      mkdirSync(binDir, { recursive: true })
      const commandPath = join(binDir, name)
      writeFileSync(commandPath, '@echo off\r\n')
      return { binDir, commandPath, root }
    }

    test('bare .cmd path produces a cmd command line cmd.exe can tokenize', () => {
      // This case reproduces the actual user bug: PATH lookup finds claude.cmd,
      // and Hive must hand node-pty a command line where cmd.exe sees the path
      // as a clean program name. The previous shape pre-quoted the path inside
      // an args array element, which node-pty's argsToCommandLine then
      // backslash-escaped — leaving cmd.exe to look up a program whose name
      // included literal quote characters.
      const { binDir, commandPath, root } = createCmdShim('agent.cmd')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        [],
        'win32'
      )

      expect(resolved.command).toBe('C:\\Windows\\System32\\cmd.exe')
      // args must be a verbatim string — node-pty appends it untouched.
      expect(typeof resolved.args).toBe('string')

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // The crucial invariants: cmd-friendly tokens, no `\"` escape on
      // anything cmd treats as the program name. `call` is the built-in that
      // handles batch invocation with quoted paths predictably.
      expect(finalCommandLine).toBe(
        `C:\\Windows\\System32\\cmd.exe /d /s /c chcp 65001 >nul && call ${commandPath}`
      )
      expect(finalCommandLine).not.toContain('\\"')
      expect(finalCommandLine).not.toMatch(/\/c "[^"]*\.cmd"/i) // not pre-quoted
    })

    test('quotes path tokens with spaces and lets cmd parse them', () => {
      const root = mkdtempSync(join(tmpdir(), 'hive cmd spaces '))
      tempDirs.push(root)
      const binDir = join(root, 'bin with spaces')
      mkdirSync(binDir, { recursive: true })
      const commandPath = join(binDir, 'agent.cmd')
      writeFileSync(commandPath, '@echo off\r\n')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        [],
        'win32'
      )

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // Path has spaces → must be wrapped in cmd-style quotes. cmd's
      // tokenizer then sees one quoted token = the full path.
      expect(finalCommandLine).toContain(`chcp 65001 >nul && call "${commandPath}"`)
    })

    test('argv with spaces survive as discrete cmd tokens', () => {
      const { binDir, commandPath, root } = createCmdShim('agent.cmd')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        ['--flag', 'value with spaces'],
        'win32'
      )

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // The argument with spaces is its own quoted cmd token; cmd will
      // tokenize it as a single argv element when running the .cmd.
      expect(finalCommandLine).toBe(
        `C:\\Windows\\System32\\cmd.exe /d /s /c chcp 65001 >nul && call ${commandPath} --flag "value with spaces"`
      )
    })

    test('argv with embedded quotes uses cmd-style "" doubling', () => {
      const { binDir, commandPath, root } = createCmdShim('agent.cmd')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        ['--prompt', 'say "hi"'],
        'win32'
      )

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      // cmd parses `""` inside a `"..."` token as a literal `"`. Using `\"`
      // (the previous behavior) would have cmd see the `\` as literal and
      // the `"` as a quote-mode toggle — exactly the failure mode we're
      // fixing.
      expect(finalCommandLine).toBe(
        `C:\\Windows\\System32\\cmd.exe /d /s /c chcp 65001 >nul && call ${commandPath} --prompt "say ""hi"""`
      )
      // Defensive: the broken backslash-escape form must not appear.
      expect(finalCommandLine).not.toContain('\\"')
    })

    test('argv with percent signs survives cmd environment expansion', () => {
      const { binDir, commandPath, root } = createCmdShim('agent.cmd')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        ['--path', 'C:\\Users\\%USERNAME%\\project'],
        'win32'
      )

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      expect(finalCommandLine).toBe(
        `C:\\Windows\\System32\\cmd.exe /d /s /c chcp 65001 >nul && call ${commandPath} --path "C:\\Users\\%%USERNAME%%\\project"`
      )
    })

    test('falls back to ComSpec value when present, else cmd.exe literal', () => {
      const { binDir, commandPath, root } = createCmdShim('agent.cmd')

      const withComSpec = resolveSpawnCommand(
        'agent',
        root,
        {
          ComSpec: 'D:\\custom\\cmd.exe',
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        [],
        'win32'
      )
      expect(withComSpec.command).toBe('D:\\custom\\cmd.exe')

      const withoutComSpec = resolveSpawnCommand(
        'agent',
        root,
        {
          Path: binDir,
          PathExt: '.cmd;.EXE',
        },
        [],
        'win32'
      )
      expect(withoutComSpec.command).toBe('cmd.exe')
      expect(typeof withoutComSpec.args).toBe('string')
      expect(withoutComSpec.args as string).toContain('chcp 65001 >nul &&')
      expect(withoutComSpec.args as string).toContain(`call ${commandPath}`)
    })

    test('cmd.exe /k shell launches keep the command tail verbatim for UNC pushd', () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-cmd-shell-'))
      tempDirs.push(root)
      const binDir = join(root, 'bin')
      mkdirSync(binDir, { recursive: true })
      const cmdPath = join(binDir, 'cmd.exe')
      writeFileSync(cmdPath, 'placeholder')

      const resolved = resolveSpawnCommand(
        'cmd.exe',
        root,
        { Path: binDir, PathExt: '.EXE' },
        ['/d', '/s', '/k', 'pushd "\\\\server\\share with spaces"'],
        'win32'
      )

      expect(resolved.command).toBe(cmdPath)
      expect(resolved.args).toBe('/d /s /k pushd "\\\\server\\share with spaces"')
      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      expect(finalCommandLine).not.toContain('\\"')
    })
  })

  describe('Windows non-batch executables', () => {
    test('passes plain .exe args as a string[] for node-pty to serialize', () => {
      // Non-batch exes don't need our verbatim path: node-pty can serialize
      // their argv normally, and CreateProcess uses standard Windows parsing.
      const root = mkdtempSync(join(tmpdir(), 'hive-exe-'))
      tempDirs.push(root)
      const binDir = join(root, 'bin')
      mkdirSync(binDir, { recursive: true })
      const commandPath = join(binDir, 'agent.exe')
      writeFileSync(commandPath, 'fake exe placeholder')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          Path: binDir,
          PathExt: '.exe;.cmd',
        },
        ['--flag'],
        'win32'
      )

      expect(resolved.command).toBe(commandPath)
      expect(resolved.args).toEqual(['--flag'])
    })

    test('does not add cmd.exe code page setup around plain .exe launches', () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-exe-'))
      tempDirs.push(root)
      const binDir = join(root, 'bin')
      mkdirSync(binDir, { recursive: true })
      const commandPath = join(binDir, 'agent.exe')
      writeFileSync(commandPath, 'fake exe placeholder')

      const resolved = resolveSpawnCommand(
        'agent',
        root,
        {
          Path: binDir,
          PathExt: '.exe;.cmd',
        },
        ['--prompt', '\u4f60\u597d'],
        'win32'
      )

      const finalCommandLine = simulateNodePtyCommandLine(resolved.command, resolved.args)
      expect(finalCommandLine).toContain(commandPath)
      expect(finalCommandLine).not.toContain('chcp 65001')
      expect(finalCommandLine).not.toContain('cmd.exe')
    })
  })
})
