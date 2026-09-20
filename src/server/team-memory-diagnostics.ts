import type { DreamRunRecord, DreamRunStatus } from './team-memory-dream-store.js'
import type { MemoryProviderDiagnostics } from './team-memory-provider.js'
import type {
  MemoryEntryWithSources,
  MemoryInjectionContext,
  MemoryInjectionWithMemory,
  MemorySearchResult,
  MemorySource,
  MemoryStatus,
} from './team-memory-store.js'

type CountMap<Key extends string> = Record<Key, number>

export interface MemoryDiagnostics {
  dreams: {
    by_status: CountMap<DreamRunStatus>
    last_finished_at: number | null
    last_started_at: number | null
    operations: {
      added: number
      archived: number
      merged: number
      rewritten: number
    }
    total: number
  }
  entries: {
    active_injectable: number
    by_scope: CountMap<'user' | 'workspace'>
    by_source: CountMap<MemorySource>
    by_status: CountMap<MemoryStatus>
    disabled: number
    never_injected_active: number
    procedure_refs: number
    stale_active: number
    total: number
  }
  generated_at: number
  injections: {
    by_context: CountMap<MemoryInjectionContext>
    distinct_memories: number
    last_injected_at: number | null
    total: number
  }
  provider: MemoryProviderDiagnostics
  retrieval: {
    query: string | null
    result_count: number
    results: Array<{
      id: string
      index_name: MemorySearchResult['indexName']
      kind: MemorySearchResult['kind']
      last_injected_at: number | null
      procedure_ref: MemorySearchResult['procedureRef']
      scope: MemorySearchResult['scope']
      score: number
      status: MemorySearchResult['status']
    }>
  }
  workspace_id: string
}

interface MemoryDiagnosticsServices {
  memoryProvider: {
    diagnostics: () => MemoryProviderDiagnostics
    retrieveDispatchEntries: (input: {
      taskText: string
      workerDescription: string
      workspaceId: string
    }) => MemorySearchResult[]
    searchEntries: (
      workspaceId: string,
      query: string,
      options?: { includeDisabled?: boolean; limit?: number; scopes?: Array<'workspace' | 'user'> }
    ) => MemorySearchResult[]
  }
  memoryStore: {
    listAllEntries: (
      workspaceId: string,
      options?: { scopes?: Array<'workspace' | 'user'> }
    ) => MemoryEntryWithSources[]
    listInjections: (workspaceId: string, limit?: number) => MemoryInjectionWithMemory[]
  }
  dreamStore: {
    listRuns: (workspaceId: string, limit?: number) => DreamRunRecord[]
  }
}

export interface BuildMemoryDiagnosticsInput {
  query?: string | null
  taskText?: string | null
  workerDescription?: string | null
  workspaceId: string
}

const freshCountMap = <Key extends string>(keys: readonly Key[]): CountMap<Key> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as CountMap<Key>

const countBy = <Key extends string, Value>(
  values: Value[],
  keys: readonly Key[],
  getKey: (value: Value) => Key
) => {
  const counts = freshCountMap(keys)
  for (const value of values) counts[getKey(value)] += 1
  return counts
}

const STALE_ACTIVE_MEMORY_MS = 90 * 24 * 60 * 60 * 1000

export const createTeamMemoryDiagnostics = (services: MemoryDiagnosticsServices) => ({
  build(input: BuildMemoryDiagnosticsInput): MemoryDiagnostics {
    const generatedAt = Date.now()
    const entries = services.memoryStore.listAllEntries(input.workspaceId, {
      scopes: ['workspace', 'user'],
    })
    const injections = services.memoryStore.listInjections(input.workspaceId, 1000)
    const dreams = services.dreamStore.listRuns(input.workspaceId, 100)
    const query = input.query?.trim()
    const taskText = input.taskText?.trim()
    const workerDescription = input.workerDescription?.trim()
    const retrievalResults =
      taskText || workerDescription
        ? services.memoryProvider.retrieveDispatchEntries({
            taskText: taskText ?? '',
            workerDescription: workerDescription ?? '',
            workspaceId: input.workspaceId,
          })
        : query
          ? services.memoryProvider.searchEntries(input.workspaceId, query, {
              includeDisabled: true,
              limit: 20,
              scopes: ['workspace', 'user'],
            })
          : []

    const activeEntries = entries.filter((entry) => entry.status === 'active')
    return {
      dreams: {
        by_status: countBy(
          dreams,
          ['running', 'completed', 'failed', 'reverted'],
          (run) => run.status
        ),
        last_finished_at: dreams.reduce<number | null>(
          (latest, run) =>
            run.finishedAt === null ? latest : Math.max(latest ?? run.finishedAt, run.finishedAt),
          null
        ),
        last_started_at: dreams.reduce<number | null>(
          (latest, run) => Math.max(latest ?? run.startedAt, run.startedAt),
          null
        ),
        operations: dreams.reduce(
          (totals, run) => {
            totals.added += run.report?.added.length ?? 0
            totals.archived += run.report?.archived.length ?? 0
            totals.merged += run.report?.merged.length ?? 0
            totals.rewritten += run.report?.rewritten.length ?? 0
            return totals
          },
          { added: 0, archived: 0, merged: 0, rewritten: 0 }
        ),
        total: dreams.length,
      },
      entries: {
        active_injectable: activeEntries.filter((entry) => !entry.disabled).length,
        by_scope: countBy(entries, ['workspace', 'user'], (entry) => entry.scope),
        by_source: countBy(entries, ['manual', 'dream'], (entry) => entry.source),
        by_status: countBy(
          entries,
          ['active', 'candidate', 'archived', 'rejected'],
          (entry) => entry.status
        ),
        disabled: entries.filter((entry) => entry.disabled).length,
        never_injected_active: activeEntries.filter((entry) => entry.lastInjectedAt === null)
          .length,
        procedure_refs: entries.filter((entry) => entry.procedureRef !== null).length,
        stale_active: activeEntries.filter(
          (entry) => generatedAt - entry.updatedAt >= STALE_ACTIVE_MEMORY_MS
        ).length,
        total: entries.length,
      },
      generated_at: generatedAt,
      injections: {
        by_context: countBy(
          injections,
          ['startup', 'dispatch', 'recovery', 'manual_search'],
          (injection) => injection.contextType
        ),
        distinct_memories: new Set(injections.map((injection) => injection.memoryId)).size,
        last_injected_at: injections.reduce<number | null>(
          (latest, injection) => Math.max(latest ?? injection.injectedAt, injection.injectedAt),
          null
        ),
        total: injections.length,
      },
      provider: services.memoryProvider.diagnostics(),
      retrieval: {
        query:
          taskText || workerDescription
            ? [taskText, workerDescription].filter(Boolean).join(' ')
            : query || null,
        result_count: retrievalResults.length,
        results: retrievalResults.slice(0, 20).map((result) => ({
          id: result.id,
          index_name: result.indexName,
          kind: result.kind,
          last_injected_at: result.lastInjectedAt,
          procedure_ref: result.procedureRef,
          scope: result.scope,
          score: result.score,
          status: result.status,
        })),
      },
      workspace_id: input.workspaceId,
    }
  },
})
