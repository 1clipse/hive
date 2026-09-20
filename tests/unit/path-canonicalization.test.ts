import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import {
  normalizeFilesystemIdentity,
  sameFilesystemPath,
} from '../../src/server/path-canonicalization.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('filesystem path identity', () => {
  test('normalizes Windows paths case-insensitively', () => {
    expect(
      sameFilesystemPath('C:\\Users\\Admin\\Project', 'c:\\users\\admin\\project', 'win32')
    ).toBe(true)
  })

  test('keeps POSIX identity case-sensitive', () => {
    expect(sameFilesystemPath('/tmp/Project', '/tmp/project', 'linux')).toBe(false)
  })

  test('resolves dot segments before comparing', () => {
    expect(normalizeFilesystemIdentity('/tmp/a/../b', 'linux')).toBe('/tmp/b')
  })

  test('uses realpath identity for existing symlink or junction aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-path-id-'))
    tempDirs.push(root)
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    mkdirSync(target)
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')

    expect(sameFilesystemPath(target, alias)).toBe(true)
  })
})
