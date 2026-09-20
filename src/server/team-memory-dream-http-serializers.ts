import type { DreamRunRecord } from './team-memory-dream-store.js'

export const serializeDreamRun = (run: DreamRunRecord) => ({
  error: run.error,
  finished_at: run.finishedAt,
  id: run.id,
  input_seq_from: run.inputSeqFrom,
  input_seq_to: run.inputSeqTo,
  report: run.report,
  started_at: run.startedAt,
  status: run.status,
  trigger: run.trigger,
  workspace_id: run.workspaceId,
})
