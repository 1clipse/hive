import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { pickFolder, type RunPickCommand } from '../../src/server/fs-pick-folder.js'

let sandboxRoot = ''
let insideDir = ''
let outsideRoot = ''
let outsideDir = ''
const tempDirs: string[] = []

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'hive-pickfolder-root-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'hive-pickfolder-outside-'))
  tempDirs.push(sandboxRoot, outsideRoot)
  insideDir = join(sandboxRoot, 'alpha-project')
  outsideDir = join(outsideRoot, 'secret')
  mkdirSync(join(insideDir, '.git'), { recursive: true })
  writeFileSync(join(insideDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(outsideDir, { recursive: true })
  process.env.HIVE_FS_BROWSE_ROOT = sandboxRoot
})

afterEach(() => {
  delete process.env.HIVE_FS_BROWSE_ROOT
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const emptySpawn = {
  spawnError: null,
  signal: null,
  stderr: '',
  stdout: '',
  status: 0 as number | null,
  timedOut: false,
}

describe('pickFolder — platform dispatch', () => {
  test('darwin: osascript stdout path flows through probeDirectory and returns probe.ok', async () => {
    const calls: Array<{ command: string; args: string[]; timeout: unknown }> = []
    const runCommand: RunPickCommand = async (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout })
      return { ...emptySpawn, stdout: `${insideDir}\n` }
    }
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(false)
    expect(result.supported).toBe(true)
    expect(result.path).toBe(insideDir)
    expect(result.probe?.ok).toBe(true)
    expect(result.probe?.is_git_repository).toBe(true)
    expect(calls[0]?.command).toBe('osascript')
    expect(calls[0]?.args[0]).toBe('-e')
    // Every platform picker must pass a timeout. Without one a wedged
    // process (PowerShell startup hang, zenity hung on DBus, osascript
    // blocked on Accessibility prompt) would tie up the request
    // indefinitely. The TIMED-OUT branch in defaultRunCommand maps the
    // killed child to `timedOut: true` so the dispatcher can surface
    // "Folder picker timed out" instead of hanging.
    expect(typeof calls[0]?.timeout).toBe('number')
    expect(calls[0]?.timeout as number).toBeGreaterThan(0)
  })

  test('darwin: user cancel (exit code 1 + -1743) yields canceled=true silently', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: 1,
      stderr: '24:45: execution error: User canceled. (-1743)',
    })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(true)
    expect(result.error).toBeNull()
    expect(result.path).toBeNull()
    expect(result.supported).toBe(true)
  })

  test('linux: zenity stdout path flows through probeDirectory', async () => {
    const calls: Array<{ command: string; args: string[]; timeout: unknown }> = []
    const runCommand: RunPickCommand = async (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout })
      return { ...emptySpawn, stdout: `${insideDir}\n` }
    }
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.path).toBe(insideDir)
    expect(result.probe?.is_git_repository).toBe(true)
    expect(calls[0]?.command).toBe('zenity')
    expect(calls[0]?.args).toContain('--directory')
    expect(typeof calls[0]?.timeout).toBe('number')
    expect(calls[0]?.timeout as number).toBeGreaterThan(0)
  })

  test('linux: zenity cancel (exit 1) is canceled, not an error', async () => {
    const runCommand: RunPickCommand = async () => ({ ...emptySpawn, status: 1 })
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.canceled).toBe(true)
    expect(result.error).toBeNull()
  })

  test('win32: native picker is disabled so the UI uses browser browse or paste path', async () => {
    const runCommand = vi.fn<RunPickCommand>(async () => ({
      ...emptySpawn,
      stdout: `${insideDir}\r\n`,
    }))
    const result = await pickFolder({ platform: 'win32', runCommand })
    expect(runCommand).not.toHaveBeenCalled()
    expect(result.supported).toBe(false)
    expect(result.canceled).toBe(false)
    expect(result.path).toBeNull()
    expect(result.probe).toBeNull()
    expect(result.error).toMatch(/disabled on Windows/)
  })

  test('other unsupported platforms still fall back to Advanced paste path', async () => {
    const result = await pickFolder({ platform: 'freebsd' })
    expect(result.supported).toBe(false)
    expect(result.canceled).toBe(false)
    expect(result.error).toMatch(/Advanced: paste path/)
    expect(result.path).toBeNull()
  })

  test('missing binary (ENOENT) flips supported=false so the UI falls back', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: 127,
      spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    })
    const result = await pickFolder({ platform: 'linux', runCommand })
    expect(result.supported).toBe(false)
    expect(result.canceled).toBe(false)
  })

  test('picked path outside the FS-browse sandbox is still accepted', async () => {
    // The OS-native folder picker is itself a user-authorization
    // surface — the user just clicked OK in their system dialog. The
    // previous behavior re-applied the in-browser sandbox to picker
    // output, which rejected every drive other than the one hosting
    // `$HOME`. On Windows (where `$HOME` is `C:\Users\<name>` but
    // projects routinely live on `D:\projects`, `E:\code`, etc.) that
    // turned the picker into "you may pick anything we then refuse".
    // The in-browser FS tree (browseDirectory) still enforces sandbox.
    const runCommand: RunPickCommand = async () => ({ ...emptySpawn, stdout: `${outsideDir}\n` })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.path).toBe(outsideDir)
    expect(result.probe?.ok).toBe(true)
    expect(result.probe?.is_dir).toBe(true)
    expect(result.error).toBeNull()
  })

  test('picked path that does not exist still reports a not-a-directory error', async () => {
    // After lifting the sandbox check we still need to fail closed when
    // the picker hands us a path that doesn't exist (rare — pickers
    // normally only return real selections — but a wedged dialog or a
    // hand-crafted spawn could produce one).
    const missingPath = join(outsideRoot, 'does-not-exist')
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      stdout: `${missingPath}\n`,
    })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.probe?.ok).toBe(false)
    expect(result.error).toMatch(/not a directory/)
  })

  test('unexpected timeout is surfaced as an error, not a silent cancel', async () => {
    const runCommand: RunPickCommand = async () => ({
      ...emptySpawn,
      status: null,
      signal: 'SIGTERM',
      timedOut: true,
    })
    const result = await pickFolder({ platform: 'darwin', runCommand })
    expect(result.canceled).toBe(false)
    expect(result.error).toMatch(/timed out/)
  })
})
