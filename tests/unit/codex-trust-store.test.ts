import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { ensureCodexDirectoryTrusted } from '../../src/server/codex-trust-store.js'

const tempDirs: string[] = []

const makeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-codex-trust-'))
  tempDirs.push(dir)
  return dir
}

const configPath = (home: string) => join(home, '.codex', 'config.toml')
const readConfig = (home: string) => readFileSync(configPath(home), 'utf8')
const seedConfig = (home: string, contents: string) => {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(configPath(home), contents, 'utf8')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('ensureCodexDirectoryTrusted', { timeout: 30000 }, () => {
  test('creates config.toml (and ~/.codex) trusting the cwd when none exists', () => {
    const home = makeHome()
    const cwd = '/Users/me/project'

    ensureCodexDirectoryTrusted(cwd, home)

    const toml = readConfig(home)
    expect(toml).toContain('[projects."/Users/me/project"]')
    expect(toml).toContain('trust_level = "trusted"')
  })

  test('appends the project table, preserving existing settings and other projects', () => {
    const home = makeHome()
    const cwd = '/Users/me/new-project'
    seedConfig(
      home,
      [
        'sandbox_mode = "danger-full-access"',
        'model = "gpt-5.5"',
        '',
        '[projects."/Users/me/other"]',
        'trust_level = "trusted"',
        '',
      ].join('\n')
    )

    ensureCodexDirectoryTrusted(cwd, home)

    const toml = readConfig(home)
    // Top-level settings preserved.
    expect(toml).toContain('sandbox_mode = "danger-full-access"')
    expect(toml).toContain('model = "gpt-5.5"')
    // Existing project preserved.
    expect(toml).toContain('[projects."/Users/me/other"]')
    // New project appended.
    expect(toml).toContain('[projects."/Users/me/new-project"]')
    // Exactly one trusted table added for the new cwd.
    const matches = toml.match(/\[projects\."\/Users\/me\/new-project"\]/g) ?? []
    expect(matches).toHaveLength(1)
  })

  test('is idempotent when the project table already exists', () => {
    const home = makeHome()
    const cwd = '/Users/me/project'
    seedConfig(home, ['[projects."/Users/me/project"]', 'trust_level = "trusted"', ''].join('\n'))
    const before = readConfig(home)

    ensureCodexDirectoryTrusted(cwd, home)

    expect(readConfig(home)).toBe(before)
  })

  test('does not match a different project whose path is a prefix of the cwd', () => {
    const home = makeHome()
    seedConfig(home, ['[projects."/Users/me/project"]', 'trust_level = "trusted"', ''].join('\n'))

    // cwd extends the existing key — must still append its own table, not
    // treat the prefix entry as a match.
    ensureCodexDirectoryTrusted('/Users/me/project-2', home)

    const toml = readConfig(home)
    expect(toml).toContain('[projects."/Users/me/project-2"]')
  })

  test('escapes quotes and backslashes in the path key', () => {
    const home = makeHome()
    const cwd = '/Users/me/weird"dir'

    ensureCodexDirectoryTrusted(cwd, home)

    const toml = readConfig(home)
    expect(toml).toContain('[projects."/Users/me/weird\\"dir"]')
    // Re-running must detect the escaped section and stay idempotent.
    const after = toml
    ensureCodexDirectoryTrusted(cwd, home)
    expect(readConfig(home)).toBe(after)
  })

  test('does not throw when ~/.codex cannot be read as expected', () => {
    const home = makeHome()
    // Seed a garbage file; we only append, so it must not throw.
    seedConfig(home, 'this is not valid toml [[[')

    expect(() => ensureCodexDirectoryTrusted('/Users/me/project', home)).not.toThrow()
    expect(readConfig(home)).toContain('[projects."/Users/me/project"]')
  })
})
