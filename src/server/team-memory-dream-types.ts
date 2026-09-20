import type { MemoryKind, MemoryProcedureRef } from '../shared/team-memory.js'
import type { MemorySource, MemorySourceType, MemoryStatus } from './team-memory-store.js'

export type DreamRunTrigger = 'manual' | 'scheduled'
export type DreamRunStatus = 'running' | 'completed' | 'failed' | 'reverted'

export interface DreamRunReport {
  added: Array<{ body: string; id: string; kind: MemoryKind }>
  archived: Array<{ id: string; reason: string | null }>
  merged: Array<{ from: string[]; into: string }>
  rewritten: Array<{ id: string }>
}

export interface MemoryEntryRow {
  archived_at: number | null
  body: string
  confidence: number | null
  created_at: number
  disabled: number
  fts_rowid: number
  id: string
  kind: MemoryKind
  last_injected_at: number | null
  pinned: number
  ref_id: string | null
  ref_title: string | null
  ref_type: MemoryProcedureRef['type'] | null
  scope: 'workspace' | 'user'
  source: MemorySource
  status: MemoryStatus
  tags: string | null
  updated_at: number
  workspace_id: string | null
}

export interface MemorySourceRow {
  actor_agent_id_snapshot: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: string | null
  created_at: number
  excerpt: string | null
  id: string
  memory_id: string
  source_id: string | null
  source_sequence: number | null
  source_type: MemorySourceType
  text_hash: string | null
}

export interface DreamRunRevertBlob {
  added_entry_ids: string[]
  prior_entries: Array<{ entry: MemoryEntryRow; sources: MemorySourceRow[] }>
}

export interface DreamRunRecord {
  error: string | null
  finishedAt: number | null
  id: string
  inputSeqFrom: number | null
  inputSeqTo: number | null
  report: DreamRunReport | null
  revertBlob: DreamRunRevertBlob | null
  startedAt: number
  status: DreamRunStatus
  trigger: DreamRunTrigger
  workspaceId: string
}

export interface DreamScheduleState {
  // Failed scheduled runs since the last successfully consumed window. Drives the
  // scheduler's exponential backoff so a poison window can't burn the CLI every floor.
  consecutiveScheduledFailures: number
  hasRunningRun: boolean
  lastScheduledAt: number | null
  pendingMessageCount: number
  runningScheduledRunId: string | null
}

export interface DreamMessageInput {
  artifacts: string | null
  createdAt: number
  fromAgentId: string | null
  sequence: number
  status: string | null
  text: string | null
  toAgentId: string | null
  type: string
  workerId: string
}

export interface DreamRunRow {
  error: string | null
  finished_at: number | null
  id: string
  input_seq_from: number | null
  input_seq_to: number | null
  report: string | null
  revert_blob: string | null
  started_at: number
  status: DreamRunStatus
  trigger: DreamRunTrigger
  workspace_id: string
}

const parseJsonField = <T>(value: string | null): T | null => {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

export const toDreamRunRecord = (row: DreamRunRow): DreamRunRecord => ({
  error: row.error,
  finishedAt: row.finished_at,
  id: row.id,
  inputSeqFrom: row.input_seq_from,
  inputSeqTo: row.input_seq_to,
  report: parseJsonField<DreamRunReport>(row.report),
  revertBlob: parseJsonField<DreamRunRevertBlob>(row.revert_blob),
  startedAt: row.started_at,
  status: row.status,
  trigger: row.trigger,
  workspaceId: row.workspace_id,
})
