import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'
import { arePathsEqual, expandHomePath, indexOfPathMarker } from './platform-path.js'

const CODEX_SESSION_FILE = /^rollout-.*\.jsonl$/i
const CODEX_SESSIONS_MARKER = '/sessions/'
const CODEX_HEADER_READ_CHUNK_BYTES = 4096
const CODEX_HEADER_MAX_BYTES = 64 * 1024

const getDefaultCodexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex')

export const getCodexHome = (pattern?: string, platform: NodeJS.Platform = process.platform) => {
  if (!pattern) return getDefaultCodexHome()
  const markerIndex = indexOfPathMarker(pattern, CODEX_SESSIONS_MARKER, platform)
  if (markerIndex === -1) return getDefaultCodexHome()
  const rawRoot = pattern.slice(0, markerIndex).replace(/[\\/]+$/u, '')
  const root = expandHomePath(rawRoot)
  if (arePathsEqual(root, join(homedir(), '.codex'), platform)) return getDefaultCodexHome()
  return root || getDefaultCodexHome()
}

const walkSessionFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walkSessionFiles(path)
      return entry.isFile() && CODEX_SESSION_FILE.test(entry.name) ? [path] : []
    })
  } catch {
    return []
  }
}

export const readCodexSessionFirstLine = (
  filePath: string,
  maxBytes = CODEX_HEADER_MAX_BYTES
): string | null => {
  const fd = openSync(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let position = 0
    let reachedLineEnd = false

    while (totalBytes < maxBytes) {
      const bytesToRead = Math.min(CODEX_HEADER_READ_CHUNK_BYTES, maxBytes - totalBytes)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position)
      if (bytesRead === 0) {
        reachedLineEnd = true
        break
      }

      const slice = buffer.subarray(0, bytesRead)
      const newlineIndex = slice.indexOf(0x0a)
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex))
        reachedLineEnd = true
        break
      }

      chunks.push(slice)
      totalBytes += bytesRead
      position += bytesRead
    }

    if (!reachedLineEnd) return null
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
  } finally {
    closeSync(fd)
  }
}

const parseCodexSession = (filePath: string) => {
  const firstLine = readCodexSessionFirstLine(filePath) ?? ''
  const parsed = JSON.parse(firstLine) as unknown
  if (!parsed || typeof parsed !== 'object' || !('payload' in parsed)) return null
  const payload = parsed.payload
  if (!payload || typeof payload !== 'object') return null
  const id = 'id' in payload && typeof payload.id === 'string' ? payload.id : null
  const cwd = 'cwd' in payload && typeof payload.cwd === 'string' ? payload.cwd : null
  return id && cwd ? { cwd, id } : null
}

const listSessionIds = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  platform: NodeJS.Platform = process.platform
) => {
  const sessionsRoot = join(codexHome, 'sessions')
  return walkSessionFiles(sessionsRoot)
    .flatMap((filePath) => {
      try {
        const session = parseCodexSession(filePath)
        return session && arePathsEqual(session.cwd, cwd, platform) ? [session.id] : []
      } catch {
        return []
      }
    })
    .sort((left, right) => left.localeCompare(right))
}

const fileNameMatchesSessionId = (filePath: string, sessionId: string) =>
  basename(filePath).endsWith(`-${sessionId}.jsonl`)

export const getCodexSessionExistence = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  codexHome: string = getCodexHome(pattern, platform)
) => {
  const sessionsRoot = join(codexHome, 'sessions')
  let foundUnverifiableMatchingFile = false
  for (const filePath of walkSessionFiles(sessionsRoot)) {
    try {
      const session = parseCodexSession(filePath)
      if (session?.id === sessionId) return arePathsEqual(session.cwd, cwd, platform)
      if (!session && fileNameMatchesSessionId(filePath, sessionId)) {
        foundUnverifiableMatchingFile = true
      }
    } catch {
      if (fileNameMatchesSessionId(filePath, sessionId)) foundUnverifiableMatchingFile = true
    }
  }
  return foundUnverifiableMatchingFile ? undefined : false
}

export const hasCodexSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  platform: NodeJS.Platform = process.platform,
  codexHome: string = getCodexHome(pattern, platform)
) => getCodexSessionExistence(cwd, sessionId, pattern, platform, codexHome) ?? false

export const snapshotCodexSessionIds = (
  cwd: string,
  codexHome = getDefaultCodexHome(),
  platform: NodeJS.Platform = process.platform
) => new Set(listSessionIds(cwd, codexHome, platform))

export const captureCodexSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  codexHome = getDefaultCodexHome()
) => {
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, codexHome),
    onCapture,
    projectKey: join(codexHome, 'sessions', cwd),
    timeoutMs,
  })
}

export const codexSessionStoreExists = (codexHome = getDefaultCodexHome()) =>
  existsSync(join(codexHome, 'sessions'))
