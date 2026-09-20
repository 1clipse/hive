import {
  buildDispatchQueries,
  DISPATCH_MEMORY_CANDIDATE_LIMIT,
  mergeSearchResults,
} from './team-memory-digest.js'
import type {
  MemoryEntryWithSources,
  MemorySearchOptions,
  MemorySearchResult,
} from './team-memory-store.js'

export interface DispatchMemoryRetrievalInput {
  taskText: string
  workerDescription: string
  workspaceId: string
}

export interface MemoryProviderDiagnostics {
  provider: 'local_sqlite'
  retrieval: {
    backend: Array<'fts_unicode' | 'fts_trigram' | 'like'>
    fallback: 'sqlite_only'
    semantic_provider: 'not_configured'
  }
}

export interface TeamMemoryProvider {
  diagnostics: () => MemoryProviderDiagnostics
  listDigestEntries: (workspaceId: string, options?: { limit?: number }) => MemoryEntryWithSources[]
  retrieveDispatchEntries: (input: DispatchMemoryRetrievalInput) => MemorySearchResult[]
  searchEntries: (
    workspaceId: string,
    query: string,
    options?: MemorySearchOptions
  ) => MemorySearchResult[]
}

interface LocalMemoryProviderStore {
  listDigestEntries: (
    workspaceId: string,
    options?: { limit?: number; scopes?: Array<'workspace' | 'user'> }
  ) => MemoryEntryWithSources[]
  searchEntries: (
    workspaceId: string,
    query: string,
    options?: MemorySearchOptions
  ) => MemorySearchResult[]
}

export const createLocalTeamMemoryProvider = ({
  memoryStore,
}: {
  memoryStore: LocalMemoryProviderStore
}): TeamMemoryProvider => {
  const searchRelevantEntries = (workspaceId: string, queries: string[]) =>
    mergeSearchResults(
      queries.flatMap((query) =>
        memoryStore.searchEntries(workspaceId, query, {
          limit: DISPATCH_MEMORY_CANDIDATE_LIMIT,
          scopes: ['workspace', 'user'],
          statuses: ['active'],
        })
      )
    )

  return {
    diagnostics: () => ({
      provider: 'local_sqlite',
      retrieval: {
        backend: ['fts_unicode', 'fts_trigram', 'like'],
        fallback: 'sqlite_only',
        semantic_provider: 'not_configured',
      },
    }),
    listDigestEntries: (workspaceId, options) => {
      const limit = Math.max(0, Math.trunc(options?.limit ?? 20))
      const userLimit = limit <= 1 ? 0 : Math.min(4, Math.max(1, Math.floor(limit / 5)))
      const workspaceLimit = Math.max(0, limit - userLimit)
      return [
        ...(workspaceLimit > 0
          ? memoryStore.listDigestEntries(workspaceId, {
              limit: workspaceLimit,
              scopes: ['workspace'],
            })
          : []),
        ...(userLimit > 0
          ? memoryStore.listDigestEntries(workspaceId, {
              limit: userLimit,
              scopes: ['user'],
            })
          : []),
      ]
    },
    retrieveDispatchEntries({ taskText, workerDescription, workspaceId }) {
      const taskEntries = searchRelevantEntries(workspaceId, buildDispatchQueries(taskText, 8))
      const roleEntries = searchRelevantEntries(
        workspaceId,
        buildDispatchQueries(workerDescription, 6)
      )
      const roleMatches = new Map(roleEntries.map((entry) => [entry.id, entry]))
      if (taskEntries.length === 0) return []

      return taskEntries.map((entry) => {
        const roleMatch = roleMatches.get(entry.id)
        if (!roleMatch) return entry
        return {
          ...entry,
          score: Math.min(entry.score, roleMatch.score),
        }
      })
    },
    searchEntries: (workspaceId, query, options) =>
      memoryStore.searchEntries(workspaceId, query, options),
  }
}
