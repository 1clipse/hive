import { escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import { readWorkspaceMemoryEnabled, workspaceMemoryEnabledKey } from './team-memory-feature.js'
import type { MemoryEntryWithSources, MemorySearchResult } from './team-memory-store.js'

export const STARTUP_MEMORY_BUDGET_CHARS = 1200
export const RECOVERY_MEMORY_BUDGET_CHARS = 800
export const DISPATCH_MEMORY_BUDGET_CHARS = 1500
export const MEMORY_DIGEST_ENTRY_LIMIT = 20
export const DISPATCH_MEMORY_ENTRY_LIMIT = 5
export const DISPATCH_MEMORY_CANDIDATE_LIMIT = 20
export const DISPATCH_MEMORY_MIN_CONFIDENCE = 0.5
export const DISPATCH_MEMORY_RECENCY_DECAY_MS = 30 * 24 * 60 * 60 * 1000

export type MemoryDigestContext = 'recovery' | 'startup'

export interface MemoryDigestPayload {
  memoryIds: string[]
  text: string
}

export interface WorkspaceMemoryDigestProvider {
  buildDigest: (input: {
    contextType: MemoryDigestContext
    workspaceId: string
  }) => MemoryDigestPayload | null
  buildDispatchDigest: (input: {
    taskText: string
    workerDescription: string
    workspaceId: string
  }) => MemoryDigestPayload | null
}

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

interface MemoryDigestStore {
  listDigestEntries: (workspaceId: string, options?: { limit?: number }) => MemoryEntryWithSources[]
  retrieveDispatchEntries?: (input: {
    taskText: string
    workerDescription: string
    workspaceId: string
  }) => MemorySearchResult[]
  searchEntries?: (
    workspaceId: string,
    query: string,
    options?: { limit?: number; statuses?: Array<'active' | 'archived' | 'candidate' | 'rejected'> }
  ) => MemorySearchResult[]
}

const charLength = (value: string) => [...value].length

const truncateChars = (value: string, maxChars: number) => {
  if (charLength(value) <= maxChars) return value
  if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars))
  return `${[...value].slice(0, maxChars - 3).join('')}...`
}

const formatEntryLine = (entry: MemoryEntryWithSources) => {
  const labels: string[] = [entry.kind]
  if (entry.scope === 'user') labels.push('user')
  if (entry.pinned) labels.push('pinned')
  if (entry.source === 'dream') labels.push('dream')
  if (entry.procedureRef) {
    const title = entry.procedureRef.title ?? entry.procedureRef.id
    labels.push(`${entry.procedureRef.type}: ${escapeHiveEnvelopeText(title)}`)
  }
  const source = entry.sources[0]
  if (source?.actorNameSnapshot)
    labels.push(`from: ${escapeHiveEnvelopeText(source.actorNameSnapshot)}`)
  if (entry.tags.length > 0) {
    labels.push(`tags: ${entry.tags.map(escapeHiveEnvelopeText).join(', ')}`)
  }
  return `- [${labels.join(', ')}] ${escapeHiveEnvelopeText(entry.body)}`
}

const appendWithinBudget = (
  lines: string[],
  line: string,
  budget: number,
  tail: string
): string | null => {
  const candidate = [...lines, line, tail].join('\n')
  if (charLength(candidate) <= budget) return line

  const base = [...lines, tail].join('\n')
  const remaining = budget - charLength(base) - 1
  if (remaining < 24) return null
  const truncated = truncateChars(line, remaining)
  return charLength([...lines, truncated, tail].join('\n')) <= budget ? truncated : null
}

const appendSection = (
  lines: string[],
  title: string,
  entries: MemoryEntryWithSources[],
  includedIds: string[],
  budget: number,
  tail: string
) => {
  let titleAdded = false
  for (const entry of entries) {
    const sectionLines = titleAdded ? lines : [...lines, title]
    const line = appendWithinBudget(sectionLines, formatEntryLine(entry), budget, tail)
    if (!line) break
    if (!titleAdded) {
      lines.push(title)
      titleAdded = true
    }
    lines.push(line)
    includedIds.push(entry.id)
  }
}

export const formatMemoryDigestBlock = ({
  budget,
  contextType,
  entries,
}: {
  budget: number
  contextType: MemoryDigestContext
  entries: MemoryEntryWithSources[]
}): MemoryDigestPayload | null => {
  const activeEntries = entries.filter((entry) => entry.status === 'active' && !entry.disabled)
  if (activeEntries.length === 0) return null

  const tail = '</hive-memory>'
  const lines = [
    `<hive-memory context="${contextType}">`,
    'Team memory that may be relevant. Verify before relying on it.',
  ]
  const includedIds: string[] = []
  const pinned = activeEntries.filter((entry) => entry.pinned)
  const digest = activeEntries.filter((entry) => !entry.pinned)

  appendSection(lines, 'Pinned:', pinned, includedIds, budget, tail)
  appendSection(lines, 'Digest:', digest, includedIds, budget, tail)
  if (includedIds.length === 0) return null

  lines.push(tail)
  return {
    memoryIds: includedIds,
    text: lines.join('\n'),
  }
}

const confidenceForDispatch = (entry: MemorySearchResult) =>
  entry.confidence ?? (entry.source === 'manual' ? 1 : 0)

// pinned = the operator's explicit "always surface this" signal: it ranks ahead of
// everything and skips recency decay, so a deliberately pinned fact never sinks out of
// the dispatch budget just because it's old or low-confidence.
const dispatchRank = (entry: MemorySearchResult, newestUpdatedAt: number) => ({
  adjustedScore:
    entry.score +
    (entry.pinned
      ? 0
      : Math.max(0, newestUpdatedAt - entry.updatedAt) / DISPATCH_MEMORY_RECENCY_DECAY_MS),
  confidence: confidenceForDispatch(entry),
  pinnedRank: entry.pinned ? 0 : 1,
  sourceRank: entry.source === 'manual' ? 0 : 1,
})

const sortDispatchEntries = (entries: MemorySearchResult[]) => {
  const newestUpdatedAt = Math.max(...entries.map((entry) => entry.updatedAt), 0)
  return [...entries].sort((left, right) => {
    const leftRank = dispatchRank(left, newestUpdatedAt)
    const rightRank = dispatchRank(right, newestUpdatedAt)
    return (
      leftRank.pinnedRank - rightRank.pinnedRank ||
      leftRank.sourceRank - rightRank.sourceRank ||
      rightRank.confidence - leftRank.confidence ||
      leftRank.adjustedScore - rightRank.adjustedScore ||
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id)
    )
  })
}

const toDispatchSearchTerms = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((term) => [...term].length >= 2)

const unique = (values: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export const buildDispatchQueries = (text: string, maxTerms: number) =>
  unique([truncateChars(text, 500), ...toDispatchSearchTerms(text).slice(0, maxTerms)])

export const mergeSearchResults = (results: MemorySearchResult[]) => {
  const byId = new Map<string, MemorySearchResult>()
  for (const result of results) {
    const previous = byId.get(result.id)
    if (!previous || result.score < previous.score) byId.set(result.id, result)
  }
  return [...byId.values()]
}

export const formatDispatchMemoryBlock = ({
  entries,
}: {
  entries: MemorySearchResult[]
}): MemoryDigestPayload | null => {
  const activeEntries = sortDispatchEntries(
    entries.filter(
      (entry) =>
        entry.status === 'active' &&
        !entry.disabled &&
        (entry.pinned || confidenceForDispatch(entry) >= DISPATCH_MEMORY_MIN_CONFIDENCE)
    )
  ).slice(0, DISPATCH_MEMORY_ENTRY_LIMIT)
  if (activeEntries.length === 0) return null

  const tail = '</hive-memory>'
  const lines = [
    '<hive-memory context="dispatch">',
    'Team memory that may be relevant (workspace/user knowledge, verify before relying on it):',
  ]
  const includedIds: string[] = []
  for (const entry of activeEntries) {
    const line = appendWithinBudget(
      lines,
      formatEntryLine(entry),
      DISPATCH_MEMORY_BUDGET_CHARS,
      tail
    )
    if (!line) break
    lines.push(line)
    includedIds.push(entry.id)
  }
  if (includedIds.length === 0) return null

  lines.push(tail)
  return {
    memoryIds: includedIds,
    text: lines.join('\n'),
  }
}

export const createWorkspaceMemoryDigestProvider = ({
  memoryStore,
  settings,
}: {
  memoryStore: MemoryDigestStore
  settings: AppStateReader
}): WorkspaceMemoryDigestProvider => {
  const enabledFor = (workspaceId: string) =>
    readWorkspaceMemoryEnabled(
      settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value ?? null
    )

  return {
    buildDigest({ contextType, workspaceId }) {
      if (!enabledFor(workspaceId)) return null

      const entries = memoryStore.listDigestEntries(workspaceId, {
        limit: MEMORY_DIGEST_ENTRY_LIMIT,
      })
      return formatMemoryDigestBlock({
        budget:
          contextType === 'startup' ? STARTUP_MEMORY_BUDGET_CHARS : RECOVERY_MEMORY_BUDGET_CHARS,
        contextType,
        entries,
      })
    },
    buildDispatchDigest({ taskText, workerDescription, workspaceId }) {
      if (!enabledFor(workspaceId)) return null

      if (memoryStore.retrieveDispatchEntries) {
        return formatDispatchMemoryBlock({
          entries: memoryStore.retrieveDispatchEntries({
            taskText,
            workerDescription,
            workspaceId,
          }),
        })
      }

      if (!memoryStore.searchEntries) return null

      const search = (queries: string[]) =>
        mergeSearchResults(
          queries.flatMap(
            (query) =>
              memoryStore.searchEntries?.(workspaceId, query, {
                limit: DISPATCH_MEMORY_CANDIDATE_LIMIT,
                statuses: ['active'],
              }) ?? []
          )
        )
      const taskEntries = search(buildDispatchQueries(taskText, 8))
      if (taskEntries.length === 0) return null

      const roleMatches = new Map(
        search(buildDispatchQueries(workerDescription, 6)).map((entry) => [entry.id, entry])
      )
      const entries = taskEntries.map((entry) => {
        const roleMatch = roleMatches.get(entry.id)
        if (!roleMatch) return entry
        return {
          ...entry,
          score: Math.min(entry.score, roleMatch.score),
        }
      })
      return formatDispatchMemoryBlock({ entries })
    },
  }
}
