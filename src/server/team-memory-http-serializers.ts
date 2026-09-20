import type {
  MemoryEntryWithSources,
  MemoryInjectionWithMemory,
  MemorySearchResult,
  MemorySourceRecord,
} from './team-memory-store.js'

const serializeMemorySource = (source: MemorySourceRecord) => ({
  actor_agent_id_snapshot: source.actorAgentIdSnapshot,
  actor_name_snapshot: source.actorNameSnapshot,
  actor_role_snapshot: source.actorRoleSnapshot,
  created_at: source.createdAt,
  excerpt: source.excerpt,
  id: source.id,
  memory_id: source.memoryId,
  source_id: source.sourceId,
  source_sequence: source.sourceSequence,
  source_type: source.sourceType,
  text_hash: source.textHash,
})

export const serializeMemoryEntry = (entry: MemoryEntryWithSources) => ({
  archived_at: entry.archivedAt,
  body: entry.body,
  confidence: entry.confidence,
  created_at: entry.createdAt,
  disabled: entry.disabled,
  id: entry.id,
  kind: entry.kind,
  last_injected_at: entry.lastInjectedAt,
  pinned: entry.pinned,
  procedure_ref: entry.procedureRef
    ? {
        id: entry.procedureRef.id,
        title: entry.procedureRef.title,
        type: entry.procedureRef.type,
      }
    : null,
  scope: entry.scope,
  source: entry.source,
  sources: entry.sources.map(serializeMemorySource),
  status: entry.status,
  tags: entry.tags,
  updated_at: entry.updatedAt,
  workspace_id: entry.workspaceId,
})

export const serializeMemorySearchResult = (entry: MemorySearchResult) => ({
  ...serializeMemoryEntry(entry),
  index_name: entry.indexName,
  score: entry.score,
})

export const serializeMemoryInjection = (injection: MemoryInjectionWithMemory) => ({
  context_type: injection.contextType,
  dispatch_id: injection.dispatchId,
  id: injection.id,
  injected_at: injection.injectedAt,
  memory: serializeMemoryEntry(injection.memory),
  memory_id: injection.memoryId,
  target_agent_id_snapshot: injection.targetAgentIdSnapshot,
  workspace_id: injection.workspaceId,
})
