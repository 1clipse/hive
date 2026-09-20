import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { ensureClaudeDirectoryTrusted } from '../../src/server/claude-trust-store.js'

const tempDirs: string[] = []

const makeHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-claude-trust-'))
  tempDirs.push(dir)
  return dir
}

const readConfig = (home: string) =>
  JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as Record<string, unknown>

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

// Each case does real mkdtemp + JSON read/write/rename on disk; under this
// repo's TS transform on a busy machine that can exceed vitest's 5s default,
// so give the suite a generous ceiling. The work itself is sub-20ms.
describe('ensureClaudeDirectoryTrusted', { timeout: 30000 }, () => {
  test('creates ~/.claude.json and trusts the cwd when no config exists', () => {
    const home = makeHome()
    const cwd = '/Users/me/project'

    ensureClaudeDirectoryTrusted(cwd, home)

    const config = readConfig(home)
    const projects = config.projects as Record<string, Record<string, unknown>>
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
    expect(Number(projects[cwd]?.projectOnboardingSeenCount)).toBeGreaterThanOrEqual(1)
  })

  test('merges in place, preserving other projects and top-level fields', () => {
    const home = makeHome()
    const cwd = '/Users/me/new-project'
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { id: 'abc' },
        projects: {
          '/Users/me/other': { hasTrustDialogAccepted: true, allowedTools: ['Read'] },
        },
      }),
      'utf8'
    )

    ensureClaudeDirectoryTrusted(cwd, home)

    const config = readConfig(home)
    // Top-level fields preserved.
    expect(config.hasCompletedOnboarding).toBe(true)
    expect(config.oauthAccount).toEqual({ id: 'abc' })
    const projects = config.projects as Record<string, Record<string, unknown>>
    // Other project untouched.
    expect(projects['/Users/me/other']).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ['Read'],
    })
    // Target project added and trusted.
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
  })

  test('flips an existing false flag to true without dropping the entry fields', () => {
    const home = makeHome()
    const cwd = '/Users/me/project'
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          [cwd]: {
            hasTrustDialogAccepted: false,
            projectOnboardingSeenCount: 0,
            allowedTools: ['Bash'],
            mcpServers: { foo: { url: 'x' } },
          },
        },
      }),
      'utf8'
    )

    ensureClaudeDirectoryTrusted(cwd, home)

    const projects = readConfig(home).projects as Record<string, Record<string, unknown>>
    expect(projects[cwd]?.hasTrustDialogAccepted).toBe(true)
    // Sibling fields in the same entry are preserved.
    expect(projects[cwd]?.allowedTools).toEqual(['Bash'])
    expect(projects[cwd]?.mcpServers).toEqual({ foo: { url: 'x' } })
  })

  test('does not throw on a corrupt config file', () => {
    const home = makeHome()
    writeFileSync(join(home, '.claude.json'), '{ this is not valid json ', 'utf8')

    expect(() => ensureClaudeDirectoryTrusted('/Users/me/project', home)).not.toThrow()
    // Recovered by rewriting from an empty base, so the cwd is now trusted.
    const projects = readConfig(home).projects as Record<string, Record<string, unknown>>
    expect(projects['/Users/me/project']?.hasTrustDialogAccepted).toBe(true)
  })

  test('is a no-op rewrite when the cwd is already trusted', () => {
    const home = makeHome()
    const cwd = '/Users/me/project'
    ensureClaudeDirectoryTrusted(cwd, home)
    const first = readFileSync(join(home, '.claude.json'), 'utf8')

    ensureClaudeDirectoryTrusted(cwd, home)
    const second = readFileSync(join(home, '.claude.json'), 'utf8')

    expect(second).toBe(first)
    expect(existsSync(join(home, '.claude.json'))).toBe(true)
  })
})
