import { randomUUID } from 'node:crypto'

import type { Database } from './sqlite.js'

export interface WorkflowScheduleRecord {
  id: string
  workspaceId: string
  scriptPath: string
  cron: string
  args: unknown
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  workspace_id: string
  script_path: string
  cron: string
  args: string | null
  enabled: number
  last_run_at: number | null
  next_run_at: number
  created_at: number
  updated_at: number
}

interface CreateInput {
  workspaceId: string
  scriptPath: string
  cron: string
  nextRunAt: number
  args?: unknown
  enabled?: boolean
}

interface UpdateInput {
  cron?: string
  args?: unknown
  enabled?: boolean
  lastRunAt?: number
  nextRunAt?: number
}

const parseArgs = (value: string | null): unknown => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const toRecord = (row: Row): WorkflowScheduleRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  scriptPath: row.script_path,
  cron: row.cron,
  args: parseArgs(row.args),
  enabled: row.enabled === 1,
  lastRunAt: row.last_run_at,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const createWorkflowScheduleStore = (db: Database) => {
  const create = (input: CreateInput): WorkflowScheduleRecord => {
    const now = Date.now()
    const record: WorkflowScheduleRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      scriptPath: input.scriptPath,
      cron: input.cron,
      args: input.args ?? null,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now,
    }
    db.prepare(
      `INSERT INTO workflow_schedules (
        id, workspace_id, script_path, cron, args, enabled,
        last_run_at, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.scriptPath,
      record.cron,
      record.args === null ? null : JSON.stringify(record.args),
      record.enabled ? 1 : 0,
      record.lastRunAt,
      record.nextRunAt,
      record.createdAt,
      record.updatedAt
    )
    return record
  }

  const update = (id: string, input: UpdateInput) => {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    if (input.cron !== undefined) {
      sets.push('cron = ?')
      values.push(input.cron)
    }
    if (input.args !== undefined) {
      sets.push('args = ?')
      values.push(input.args === null ? null : JSON.stringify(input.args))
    }
    if (input.enabled !== undefined) {
      sets.push('enabled = ?')
      values.push(input.enabled ? 1 : 0)
    }
    if (input.lastRunAt !== undefined) {
      sets.push('last_run_at = ?')
      values.push(input.lastRunAt)
    }
    if (input.nextRunAt !== undefined) {
      sets.push('next_run_at = ?')
      values.push(input.nextRunAt)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)
    db.prepare(`UPDATE workflow_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  const get = (id: string): WorkflowScheduleRecord | undefined => {
    const row = db.prepare('SELECT * FROM workflow_schedules WHERE id = ?').get(id) as
      | Row
      | undefined
    return row ? toRecord(row) : undefined
  }

  const listForWorkspace = (workspaceId: string): WorkflowScheduleRecord[] =>
    (
      db
        .prepare(
          'SELECT * FROM workflow_schedules WHERE workspace_id = ? ORDER BY created_at DESC, id DESC'
        )
        .all(workspaceId) as Row[]
    ).map(toRecord)

  // Enabled schedules whose next_run_at has arrived — the scheduler queries
  // this every tick and fires each.
  const listDueSchedules = (now: number): WorkflowScheduleRecord[] =>
    (
      db
        .prepare(
          'SELECT * FROM workflow_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at'
        )
        .all(now) as Row[]
    ).map(toRecord)

  const deleteSchedule = (id: string) => {
    db.prepare('DELETE FROM workflow_schedules WHERE id = ?').run(id)
  }

  // TIER 1 #5 — compare-and-swap claim. If two scheduler ticks see the same
  // due schedule (overlapping setInterval invocations, slow esbuild
  // transpile in startWorkflow, or future multi-process), only the one
  // whose UPDATE matches the still-original next_run_at wins. Returns
  // true if the caller may proceed to fire the workflow.
  const claimDueSchedule = (input: {
    id: string
    expectedNextRunAt: number
    newNextRunAt: number
    lastRunAt: number
  }): boolean => {
    const result = db
      .prepare(
        `UPDATE workflow_schedules
         SET next_run_at = ?, last_run_at = ?, updated_at = ?
         WHERE id = ? AND next_run_at = ?`
      )
      .run(input.newNextRunAt, input.lastRunAt, Date.now(), input.id, input.expectedNextRunAt)
    return result.changes === 1
  }

  return {
    create,
    update,
    get,
    listForWorkspace,
    listDueSchedules,
    deleteSchedule,
    claimDueSchedule,
  }
}
