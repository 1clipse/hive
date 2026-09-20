import { randomUUID } from 'node:crypto'

import type { Database } from './sqlite.js'

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped'

export interface WorkflowRunRecord {
  id: string
  workspaceId: string
  scriptPath: string
  scriptHash: string | null
  name: string
  status: WorkflowRunStatus
  phase: string | null
  args: unknown
  result: unknown
  startedAt: number
  finishedAt: number | null
  error: string | null
  createdAt: number
  /** Count of `agent()` calls dispatched by this run. TIER 1 #14 — lets the
   *  Drawer show "12 agents" on the row without an extra round-trip per
   *  expand. Cheap subquery against the indexed workflow_run_id column. */
  agentCount: number
  /** TIER 2 #5: parent workflow run id for nested workflow() calls.
   *  Null on top-level runs. The Drawer uses this to render a child run
   *  indented under its parent (and to collapse/expand together). */
  parentRunId: string | null
}

interface WorkflowRunRow {
  id: string
  workspace_id: string
  script_path: string
  script_hash: string | null
  name: string
  status: WorkflowRunStatus
  phase: string | null
  args: string | null
  result: string | null
  started_at: number
  finished_at: number | null
  error: string | null
  created_at: number
  agent_count: number
  parent_run_id: string | null
}

interface CreateRunInput {
  workspaceId: string
  scriptPath: string
  name: string
  scriptHash?: string
  args?: unknown
  /** TIER 2 #5 — set when this run is being created from a nested
   *  workflow() call. Null/omitted for top-level runs. */
  parentRunId?: string | null
}

interface UpdateRunInput {
  status?: WorkflowRunStatus
  phase?: string
  finishedAt?: number
  error?: string
  result?: unknown
}

const parseArgs = (value: string | null): unknown => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const toRecord = (row: WorkflowRunRow): WorkflowRunRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  scriptPath: row.script_path,
  scriptHash: row.script_hash,
  name: row.name,
  status: row.status,
  phase: row.phase,
  args: parseArgs(row.args),
  result: parseArgs(row.result),
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
  createdAt: row.created_at,
  agentCount: Number(row.agent_count ?? 0),
  parentRunId: row.parent_run_id ?? null,
})

// Selects every workflow_runs column plus the agent_count subquery; used by
// both getRun and listWorkspaceRuns so the WorkflowRunRecord shape is
// uniform regardless of which path produced it.
const SELECT_RUN_COLUMNS =
  'workflow_runs.*, ' +
  '(SELECT COUNT(*) FROM dispatches WHERE dispatches.workflow_run_id = workflow_runs.id) AS agent_count'

export const createWorkflowRunStore = (db: Database) => {
  const createRun = (input: CreateRunInput): WorkflowRunRecord => {
    const now = Date.now()
    const record: WorkflowRunRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      scriptPath: input.scriptPath,
      scriptHash: input.scriptHash ?? null,
      name: input.name,
      status: 'running',
      phase: null,
      args: input.args ?? null,
      result: null,
      startedAt: now,
      finishedAt: null,
      error: null,
      createdAt: now,
      agentCount: 0,
      parentRunId: input.parentRunId ?? null,
    }
    db.prepare(
      `INSERT INTO workflow_runs (
        id, workspace_id, script_path, script_hash, name, status, phase, args,
        started_at, finished_at, error, created_at, parent_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.scriptPath,
      record.scriptHash,
      record.name,
      record.status,
      record.phase,
      record.args === null ? null : JSON.stringify(record.args),
      record.startedAt,
      record.finishedAt,
      record.error,
      record.createdAt,
      record.parentRunId
    )
    return record
  }

  const updateRun = (id: string, input: UpdateRunInput) => {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    if (input.status !== undefined) {
      sets.push('status = ?')
      values.push(input.status)
    }
    if (input.phase !== undefined) {
      sets.push('phase = ?')
      values.push(input.phase)
    }
    if (input.finishedAt !== undefined) {
      sets.push('finished_at = ?')
      values.push(input.finishedAt)
    }
    if (input.error !== undefined) {
      sets.push('error = ?')
      values.push(input.error)
    }
    if (input.result !== undefined) {
      sets.push('result = ?')
      values.push(input.result === null ? null : JSON.stringify(input.result))
    }
    if (sets.length === 0) return
    values.push(id)
    db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  const getRun = (id: string): WorkflowRunRecord | undefined => {
    const row = db
      .prepare(`SELECT ${SELECT_RUN_COLUMNS} FROM workflow_runs WHERE id = ?`)
      .get(id) as WorkflowRunRow | undefined
    return row ? toRecord(row) : undefined
  }

  const listWorkspaceRuns = (workspaceId: string): WorkflowRunRecord[] =>
    (
      db
        .prepare(
          `SELECT ${SELECT_RUN_COLUMNS} FROM workflow_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC`
        )
        .all(workspaceId) as WorkflowRunRow[]
    ).map(toRecord)

  const listChildRuns = (parentRunId: string): WorkflowRunRecord[] =>
    (
      db
        .prepare(
          `SELECT ${SELECT_RUN_COLUMNS} FROM workflow_runs WHERE parent_run_id = ? ORDER BY created_at DESC, id DESC`
        )
        .all(parentRunId) as WorkflowRunRow[]
    ).map(toRecord)

  const hasRunningTopLevelRun = (workspaceId: string, scriptPath: string): boolean =>
    Boolean(
      db
        .prepare(
          `SELECT 1 AS ok FROM workflow_runs
           WHERE workspace_id = ? AND script_path = ? AND status = 'running' AND parent_run_id IS NULL
           LIMIT 1`
        )
        .get(workspaceId, scriptPath)
    )

  // Boot sweep: a run still 'running' after a restart can never resume, so mark
  // it interrupted (spec §13 — the UI offers Resume; we never auto-resume).
  const markUnfinishedRunsInterrupted = () => {
    db.prepare(
      "UPDATE workflow_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'"
    ).run(Date.now())
  }

  return {
    createRun,
    updateRun,
    getRun,
    listWorkspaceRuns,
    listChildRuns,
    hasRunningTopLevelRun,
    markUnfinishedRunsInterrupted,
  }
}
