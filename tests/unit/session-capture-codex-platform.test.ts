import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  getCodexHome,
  hasCodexSession,
  snapshotCodexSessionIds,
} from '../../src/server/session-capture-codex.js'

const tempDirs: string[] = []

const makeTempDir = (prefix: string) => {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

const writeCodexSessionFile = (codexHome: string, cwdInPayload: string, sessionId: string) => {
  const sessionDir = join(codexHome, 'sessions', '2026', '04', '30')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, `rollout-2026-04-30T00-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({ payload: { cwd: cwdInPayload, id: sessionId }, type: 'session_meta' })}\n`
  )
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('codex session capture B9 — case-insensitive cwd on win32', () => {
  test('matches a case-mismatched cwd against the Codex rollout payload on win32', () => {
    const codexHome = makeTempDir('hive-codex-b9-win32')
    const payloadCwd = 'C:\\Users\\Admin\\workspace'
    const queryCwd = 'c:\\users\\admin\\workspace'
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    writeCodexSessionFile(codexHome, payloadCwd, sessionId)

    expect(snapshotCodexSessionIds(queryCwd, codexHome, 'win32')).toEqual(new Set([sessionId]))
    expect(hasCodexSession(queryCwd, sessionId, undefined, 'win32', codexHome)).toBe(true)
  })

  test('rejects a case-mismatched cwd on linux (case-sensitive)', () => {
    const codexHome = makeTempDir('hive-codex-b9-linux')
    const payloadCwd = '/home/Admin/workspace'
    const queryCwd = '/home/admin/workspace'
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    writeCodexSessionFile(codexHome, payloadCwd, sessionId)

    expect(snapshotCodexSessionIds(queryCwd, codexHome, 'linux')).toEqual(new Set())
    expect(hasCodexSession(queryCwd, sessionId, undefined, 'linux', codexHome)).toBe(false)
  })

  test('treats forward and backward slashes as equivalent on win32 cwd compare', () => {
    const codexHome = makeTempDir('hive-codex-b9-slash')
    const payloadCwd = 'C:\\Users\\admin\\workspace'
    const queryCwd = 'C:/Users/admin/workspace'
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288f'
    writeCodexSessionFile(codexHome, payloadCwd, sessionId)

    expect(snapshotCodexSessionIds(queryCwd, codexHome, 'win32')).toEqual(new Set([sessionId]))
  })
})

describe('codex session capture B10 — backslash sessions marker on win32', () => {
  test('recognizes a backslash-style ~\\.codex\\sessions\\ marker on win32', () => {
    const pattern = '~\\.codex\\sessions\\**\\*.jsonl'
    expect(getCodexHome(pattern, 'win32')).toBe(getCodexHome('~/.codex/sessions/**/*.jsonl'))
  })

  test('extracts the codex home from a non-default backslash root on win32', () => {
    const pattern = 'C:\\custom\\codex\\sessions\\**\\*.jsonl'
    expect(getCodexHome(pattern, 'win32')).toBe('C:\\custom\\codex')
  })

  test('falls back to default home when no backslash marker present and pattern uses backslashes on linux', () => {
    const pattern = '~\\.codex\\sessions\\**\\*.jsonl'
    expect(getCodexHome(pattern, 'linux')).toBe(getCodexHome())
  })
})
