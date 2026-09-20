import { randomUUID } from 'node:crypto'

import type { Database } from './sqlite.js'

import {
  type DreamMessageInput,
  type DreamRunRecord,
  type DreamRunRow,
  type DreamRunTrigger,
  type DreamScheduleState,
  toDreamRunRecord,
} from './team-memory-dream-types.js'

const DREAM_INPUT_MESSAGE_TYPES = "'user_input', 'send', 'report'"
export const DREAM_RUNNING_STALE_MS = 10 * 60 * 1000
export const DREAM_STALE_ERROR = 'Dream run exceeded the stale running window'
export const DREAM_NO_ACTIVE_ORCHESTRATOR_ERROR_PREFIX = 'No active run for agent:'

export class DreamRunAlreadyRunningError extends Error {
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super(`Dream run already running for workspace: ${workspaceId}`)
    this.name = 'DreamRunAlreadyRunningError'
    this.workspaceId = workspaceId
  }
}

export class DreamWorkspaceMissingError extends Error {
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super(`Dream workspace not found: ${workspaceId}`)
    this.name = 'DreamWorkspaceMissingError'
    this.workspaceId = workspaceId
  }
}

export const createDreamRunStore = (db: Database) => {
  const requireWorkspace = (workspaceId: string) => {
    const row = db.prepare('SELECT id FROM workspaces WHERE id = ? LIMIT 1').get(workspaceId) as
      | { id: string }
      | undefined
    if (!row) throw new DreamWorkspaceMissingError(workspaceId)
  }

  const markStaleRunningRuns = (workspaceId: string) => {
    const now = Date.now()
    db.prepare(
      `UPDATE dream_runs
       SET status = 'failed',
           finished_at = COALESCE(finished_at, ?),
           error = COALESCE(error, ?)
       WHERE workspace_id = ?
         AND status = 'running'
         AND started_at < ?`
    ).run(now, DREAM_STALE_ERROR, workspaceId, now - DREAM_RUNNING_STALE_MS)
  }

  const hasRunningRun = (workspaceId: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM dream_runs
           WHERE workspace_id = ?
             AND status = 'running'`
        )
        .get(workspaceId) as { count: number }
    ).count > 0

  const getRunningScheduledRun = (workspaceId: string): DreamRunRecord | undefined => {
    markStaleRunningRuns(workspaceId)
    const row = db
      .prepare(
        `SELECT *
         FROM dream_runs
         WHERE workspace_id = ?
           AND trigger = 'scheduled'
           AND status = 'running'
         ORDER BY started_at ASC, id ASC
         LIMIT 1`
      )
      .get(workspaceId) as DreamRunRow | undefined
    return row ? toDreamRunRecord(row) : undefined
  }

  const getRun = (runId: string): DreamRunRecord | undefined => {
    const row = db.prepare('SELECT * FROM dream_runs WHERE id = ? LIMIT 1').get(runId) as
      | DreamRunRow
      | undefined
    if (row?.status === 'running') {
      markStaleRunningRuns(row.workspace_id)
      const refreshed = db.prepare('SELECT * FROM dream_runs WHERE id = ? LIMIT 1').get(runId) as
        | DreamRunRow
        | undefined
      return refreshed ? toDreamRunRecord(refreshed) : undefined
    }
    return row ? toDreamRunRecord(row) : undefined
  }

  const listRuns = (workspaceId: string, limit = 20): DreamRunRecord[] => {
    markStaleRunningRuns(workspaceId)
    return (
      db
        .prepare(
          `SELECT
           id,
           workspace_id,
           trigger,
           status,
           started_at,
           finished_at,
           input_seq_from,
           input_seq_to,
           report,
           NULL AS revert_blob,
           error
         FROM dream_runs
         WHERE workspace_id = ?
         ORDER BY started_at DESC, id DESC
         LIMIT ?`
        )
        .all(workspaceId, limit) as DreamRunRow[]
    ).map(toDreamRunRecord)
  }

  const requireRun = (runId: string): DreamRunRecord => {
    const run = getRun(runId)
    if (!run) throw new Error(`Dream run not found: ${runId}`)
    return run
  }

  // Manual and scheduled runs resume from the last *successfully consumed* window
  // (completed or reverted). A failed run does not advance this watermark, so its window
  // is retried on the next run rather than silently skipped.
  const latestConsumedSeq = (workspaceId: string) =>
    (
      db
        .prepare(
          `SELECT MAX(input_seq_to) AS last
           FROM dream_runs
           WHERE workspace_id = ?
             AND status IN ('completed', 'reverted')`
        )
        .get(workspaceId) as { last: number | null }
    ).last

  const inputWindow = (workspaceId: string) => {
    const lastSeq = latestConsumedSeq(workspaceId) ?? 0
    return db
      .prepare(
        `SELECT MIN(sequence) AS seq_from, MAX(sequence) AS seq_to
         FROM messages
         WHERE workspace_id = ?
           AND sequence > ?
           AND type IN (${DREAM_INPUT_MESSAGE_TYPES})`
      )
      .get(workspaceId, lastSeq) as { seq_from: number | null; seq_to: number | null }
  }

  const getScheduleState = (workspaceId: string): DreamScheduleState => {
    markStaleRunningRuns(workspaceId)
    const lastSeq = latestConsumedSeq(workspaceId) ?? 0
    // Scheduled failures after the most recent success mark how many times the current
    // (un-advanced) window has been retried. Offline-orchestrator failures are excluded
    // from the exponential backoff counter, but still count as the last scheduled attempt
    // so the scheduler retries at the base floor instead of every tick.
    const lastSuccessAt =
      (
        db
          .prepare(
            `SELECT MAX(started_at) AS at
             FROM dream_runs
             WHERE workspace_id = ?
               AND status IN ('completed', 'reverted')`
          )
          .get(workspaceId) as { at: number | null }
      ).at ?? 0
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running_count,
           COALESCE(
             SUM(
               CASE
                 WHEN trigger = 'scheduled'
                  AND status = 'failed'
                  AND started_at > ?
                  AND error NOT LIKE '${DREAM_NO_ACTIVE_ORCHESTRATOR_ERROR_PREFIX}%'
                 THEN 1 ELSE 0
               END
             ),
             0
           ) AS consecutive_scheduled_failures,
           MAX(
             CASE
               WHEN trigger = 'scheduled' THEN started_at ELSE NULL
             END
           ) AS last_scheduled_at,
           MIN(
             CASE
               WHEN trigger = 'scheduled' AND status = 'running' THEN id ELSE NULL
             END
           ) AS running_scheduled_run_id,
           (
             SELECT COUNT(*)
             FROM messages
             WHERE workspace_id = ?
               AND sequence > ?
               AND type IN (${DREAM_INPUT_MESSAGE_TYPES})
           ) AS pending_message_count
         FROM dream_runs
         WHERE workspace_id = ?`
      )
      .get(lastSuccessAt, workspaceId, lastSeq, workspaceId) as {
      consecutive_scheduled_failures: number
      last_scheduled_at: number | null
      pending_message_count: number
      running_count: number
      running_scheduled_run_id: string | null
    }
    return {
      consecutiveScheduledFailures: row.consecutive_scheduled_failures,
      hasRunningRun: row.running_count > 0,
      lastScheduledAt: row.last_scheduled_at,
      pendingMessageCount: row.pending_message_count,
      runningScheduledRunId: row.running_scheduled_run_id,
    }
  }

  const createRun = (input: { trigger: DreamRunTrigger; workspaceId: string }) => {
    requireWorkspace(input.workspaceId)
    markStaleRunningRuns(input.workspaceId)
    if (hasRunningRun(input.workspaceId)) throw new DreamRunAlreadyRunningError(input.workspaceId)
    const id = randomUUID()
    const now = Date.now()
    const window = inputWindow(input.workspaceId)
    db.prepare(
      `INSERT INTO dream_runs (
        id,
        workspace_id,
        trigger,
        status,
        started_at,
        finished_at,
        input_seq_from,
        input_seq_to,
        report,
        revert_blob,
        error
      ) VALUES (?, ?, ?, 'running', ?, NULL, ?, ?, NULL, NULL, NULL)`
    ).run(id, input.workspaceId, input.trigger, now, window.seq_from, window.seq_to)
    return requireRun(id)
  }

  const markFailed = (runId: string, error: string, fallback?: DreamRunRecord) => {
    const finishedAt = Date.now()
    db.prepare(
      `UPDATE dream_runs
       SET status = 'failed',
           finished_at = ?,
           error = ?
       WHERE id = ?
         AND status = 'running'`
    ).run(finishedAt, error, runId)
    const run = getRun(runId)
    if (run) return run
    if (fallback) return { ...fallback, error, finishedAt, status: 'failed' as const }
    throw new Error(`Dream run not found: ${runId}`)
  }

  const listInputMessages = (workspaceId: string, from: number | null, to: number | null) => {
    if (from === null || to === null) return []
    return db
      .prepare(
        `SELECT
           sequence,
           worker_id AS workerId,
           type,
           from_agent_id AS fromAgentId,
           to_agent_id AS toAgentId,
           text,
           status,
           artifacts,
           created_at AS createdAt
         FROM messages
         WHERE workspace_id = ?
           AND sequence BETWEEN ? AND ?
           AND type IN (${DREAM_INPUT_MESSAGE_TYPES})
         ORDER BY sequence ASC`
      )
      .all(workspaceId, from, to) as DreamMessageInput[]
  }

  const deleteWorkspaceDreamRuns = (workspaceId: string) => {
    db.prepare('DELETE FROM dream_runs WHERE workspace_id = ?').run(workspaceId)
  }

  return {
    createRun,
    deleteWorkspaceDreamRuns,
    getScheduleState,
    getRunningScheduledRun,
    getRun,
    listInputMessages,
    listRuns,
    markFailed,
  }
}
