import { homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getDefaultOpenCodeDbPath } from '../../src/server/session-capture-opencode.js'

const originalLocalAppData = process.env.LOCALAPPDATA
const originalXdgDataHome = process.env.XDG_DATA_HOME
const originalOverride = process.env.HIVE_OPENCODE_DB_PATH

afterEach(() => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome
  if (originalOverride === undefined) delete process.env.HIVE_OPENCODE_DB_PATH
  else process.env.HIVE_OPENCODE_DB_PATH = originalOverride
})

describe('getDefaultOpenCodeDbPath', () => {
  test('win32 uses %LOCALAPPDATA%\\opencode\\opencode.db when LOCALAPPDATA is set', () => {
    // OpenCode upstream's data directory on Windows is
    // %LOCALAPPDATA%\opencode\opencode.db. XDG_DATA_HOME is not a
    // Windows convention and is essentially never set there, so the
    // previous default (~/.local/share/opencode/opencode.db) pointed
    // at a path that never exists. Layer A native session resume
    // failed silently as a result; Hive fell back to its Layer B
    // summary handoff and lost prior conversation context.
    process.env.LOCALAPPDATA = 'C:\\Users\\admin\\AppData\\Local'
    delete process.env.HIVE_OPENCODE_DB_PATH
    expect(getDefaultOpenCodeDbPath('win32')).toBe(
      join('C:\\Users\\admin\\AppData\\Local', 'opencode', 'opencode.db')
    )
  })

  test('win32 falls back to homedir()\\AppData\\Local when LOCALAPPDATA is unset', () => {
    // Defensive: Hive may be launched from a shell that strips env
    // vars (some Windows Task Scheduler configs do this). homedir()
    // is always available because Node derives it from USERPROFILE.
    delete process.env.LOCALAPPDATA
    delete process.env.HIVE_OPENCODE_DB_PATH
    expect(getDefaultOpenCodeDbPath('win32')).toBe(
      join(homedir(), 'AppData', 'Local', 'opencode', 'opencode.db')
    )
  })

  test('linux uses XDG_DATA_HOME when set', () => {
    process.env.XDG_DATA_HOME = '/custom/xdg'
    delete process.env.HIVE_OPENCODE_DB_PATH
    expect(getDefaultOpenCodeDbPath('linux')).toBe(join('/custom/xdg', 'opencode', 'opencode.db'))
  })

  test('linux falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
    delete process.env.XDG_DATA_HOME
    delete process.env.HIVE_OPENCODE_DB_PATH
    expect(getDefaultOpenCodeDbPath('linux')).toBe(
      join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
    )
  })

  test('darwin uses the same XDG-style path as linux', () => {
    delete process.env.XDG_DATA_HOME
    delete process.env.HIVE_OPENCODE_DB_PATH
    expect(getDefaultOpenCodeDbPath('darwin')).toBe(
      join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
    )
  })

  test('HIVE_OPENCODE_DB_PATH override wins on every platform', () => {
    process.env.HIVE_OPENCODE_DB_PATH = '/tmp/custom-opencode.db'
    expect(getDefaultOpenCodeDbPath('win32')).toBe('/tmp/custom-opencode.db')
    expect(getDefaultOpenCodeDbPath('linux')).toBe('/tmp/custom-opencode.db')
    expect(getDefaultOpenCodeDbPath('darwin')).toBe('/tmp/custom-opencode.db')
  })
})
