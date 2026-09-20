import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { resolveDataDir } from '../../src/cli/hive.js'

const neverExists = () => false
const alwaysExists = () => true

describe('resolveDataDir', () => {
  test('win32 with APPDATA set resolves to %APPDATA%\\hive', () => {
    expect(
      resolveDataDir('win32', { APPDATA: 'C:\\Users\\admin\\AppData\\Roaming' }, neverExists)
    ).toBe(join('C:\\Users\\admin\\AppData\\Roaming', 'hive'))
  })

  test('win32 with APPDATA unset falls back to homedir()\\AppData\\Roaming\\hive', () => {
    expect(resolveDataDir('win32', {}, neverExists)).toBe(
      join(homedir(), 'AppData', 'Roaming', 'hive')
    )
  })

  test('linux with XDG_CONFIG_HOME set resolves to <xdg>/hive', () => {
    expect(resolveDataDir('linux', { XDG_CONFIG_HOME: '/custom' }, neverExists)).toBe(
      join('/custom', 'hive')
    )
  })

  test('linux without XDG_CONFIG_HOME falls back to ~/.config/hive', () => {
    expect(resolveDataDir('linux', {}, neverExists)).toBe(join(homedir(), '.config', 'hive'))
  })

  test('darwin behaves the same as linux (XDG_CONFIG_HOME or ~/.config/hive)', () => {
    expect(resolveDataDir('darwin', {}, neverExists)).toBe(join(homedir(), '.config', 'hive'))
    expect(resolveDataDir('darwin', { XDG_CONFIG_HOME: '/custom' }, neverExists)).toBe(
      join('/custom', 'hive')
    )
  })

  test('HIVE_DATA_DIR override wins on every platform', () => {
    const env = { HIVE_DATA_DIR: '/tmp/explicit', APPDATA: 'C:\\Roaming', XDG_CONFIG_HOME: '/xdg' }
    expect(resolveDataDir('win32', env, alwaysExists)).toBe('/tmp/explicit')
    expect(resolveDataDir('linux', env, alwaysExists)).toBe('/tmp/explicit')
    expect(resolveDataDir('darwin', env, alwaysExists)).toBe('/tmp/explicit')
  })

  test('win32: when legacy ~/.config/hive exists and the APPDATA target does not, the legacy path wins', () => {
    // Migration: pre-fix Windows installs wrote to ~/.config/hive. After the
    // fix flips the default to %APPDATA%\hive, those users' workspace list
    // would appear empty because the new directory is fresh. Detect the
    // legacy directory and keep reading from it until a migration path is
    // shipped, so the upgrade is non-destructive.
    const legacy = join(homedir(), '.config', 'hive')
    const target = join('C:\\Users\\admin\\AppData\\Roaming', 'hive')
    const pathExists = (path: string) => path === legacy
    expect(
      resolveDataDir('win32', { APPDATA: 'C:\\Users\\admin\\AppData\\Roaming' }, pathExists)
    ).toBe(legacy)
    expect(target).not.toBe(legacy)
  })

  test('win32: when both legacy and APPDATA target exist, the new APPDATA target wins', () => {
    // The legacy fallback is a one-way ratchet: only used when the new
    // location does not yet exist. Once a Hive instance has written to
    // %APPDATA%\hive, that becomes authoritative — we don't want to
    // silently switch back to a stale legacy dir.
    expect(
      resolveDataDir('win32', { APPDATA: 'C:\\Users\\admin\\AppData\\Roaming' }, alwaysExists)
    ).toBe(join('C:\\Users\\admin\\AppData\\Roaming', 'hive'))
  })
})
