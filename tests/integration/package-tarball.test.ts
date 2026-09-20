import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, test } from 'vitest'

interface PackFile {
  path: string
}

interface PackResult {
  files: PackFile[]
  name: string
  version: string
}

const execFileAsync = promisify(execFile)

const runNpm = async (args: string[]) => {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'cmd.exe' : 'npm',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args,
    {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }
  )
  return String(stdout)
}

describe('npm package tarball', () => {
  test('publish dry-run exposes only runtime files and the hive bin', async () => {
    expect(existsSync(join(process.cwd(), 'dist', 'src', 'cli', 'hive.js'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))).toBe(true)

    const output = await runNpm(['pack', '--dry-run', '--json'])
    const packed = JSON.parse(output)
    const results = (
      Array.isArray(packed) ? packed : packed.filename ? [packed] : Object.values(packed)
    ) as PackResult[]
    expect(results).toHaveLength(1)
    const [result] = results
    if (!result) throw new Error('npm pack returned no package')
    const paths = result.files.map((file) => file.path)

    expect(result.name).toBe('@tt-a1i/hive')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(paths).toContain('dist/src/cli/hive.js')
    expect(paths).toContain('dist/src/cli/team.js')
    expect(paths).toContain('dist/bin/team')
    expect(paths).toContain('dist/bin/team.cmd')
    expect(paths).toContain('web/dist/index.html')
    expect(paths).not.toContain('scripts/postinstall-native-artifacts.mjs')
    expect(paths).toContain('CHANGELOG.md')
    expect(paths).toContain('LICENSE')
    expect(paths).toContain('README.md')
    expect(paths).toContain('SECURITY.md')

    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('tests/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('web/src/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('dist/tests/'))).toBe(false)
    expect(paths.some((path) => path.endsWith('.map'))).toBe(false)
    expect(paths).not.toContain('AGENTS.md')
    expect(paths).not.toContain('CLAUDE.md')
    expect(paths).not.toContain('TODO.md')
    expect(paths).not.toContain('bin/team')
  }, 30_000)

  test.each([
    false,
    true,
  ])('published tarball installs and starts (default scripts: %s)', async (defaultInstall) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['scripts/pack-smoke.mjs', ...(defaultInstall ? ['--default-install'] : [])],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300_000,
      }
    )
    expect(stdout).toContain(
      `${defaultInstall ? 'Default' : 'Scriptless'} global install: HTTP, SQLite and internal team list protocol passed`
    )
  }, 310_000)
})
