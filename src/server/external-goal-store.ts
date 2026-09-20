import { randomUUID } from 'node:crypto'

import type { Database } from './sqlite.js'

export const EXTERNAL_GOAL_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const

export type ExternalGoalStatus = (typeof EXTERNAL_GOAL_STATUSES)[number]

export const EXTERNAL_GOAL_REPORT_STATUSES = ['progress', 'done', 'blocked', 'failed'] as const

export type ExternalGoalReportStatus = (typeof EXTERNAL_GOAL_REPORT_STATUSES)[number]

export const EXTERNAL_GOAL_EVENT_KINDS = [
  'goal_started',
  'goal_continued',
  'goal_delivered',
  'progress_reported',
  'goal_done',
  'goal_blocked',
  'goal_failed',
  'goal_cancelled',
  'delivery_failed',
] as const

export type ExternalGoalEventKind = (typeof EXTERNAL_GOAL_EVENT_KINDS)[number]

export interface ExternalGoalSession {
  closedAt: number | null
  context: unknown
  createdAt: number
  goal: string
  id: string
  source: string
  status: ExternalGoalStatus
  summary: string | null
  title: string | null
  updatedAt: number
  workspaceId: string
}

export interface ExternalGoalEvent {
  artifacts: string[]
  body: string
  createdAt: number
  goalId: string
  id: string
  kind: ExternalGoalEventKind
  sequence: number
  status: ExternalGoalReportStatus | ExternalGoalStatus | null
  workspaceId: string
}

interface ExternalGoalSessionRow {
  closed_at: number | null
  context_json: string
  created_at: number
  goal: string
  id: string
  source: string
  status: ExternalGoalStatus
  summary: string | null
  title: string | null
  updated_at: number
  workspace_id: string
}

interface ExternalGoalEventRow {
  artifacts_json: string
  body: string
  created_at: number
  goal_id: string
  id: string
  kind: ExternalGoalEventKind
  sequence: number
  status: ExternalGoalReportStatus | ExternalGoalStatus | null
  workspace_id: string
}

interface CreateExternalGoalInput {
  context?: unknown
  goal: string
  source: string
  workspaceId: string
}

interface AppendExternalGoalEventInput {
  artifacts?: string[]
  body: string
  goalId: string
  kind: ExternalGoalEventKind
  sessionStatus?: ExternalGoalStatus
  status?: ExternalGoalEvent['status']
}

const CLOSED_STATUSES = new Set<ExternalGoalStatus>(['blocked', 'done', 'failed', 'cancelled'])

export const isExternalGoalReportStatus = (value: unknown): value is ExternalGoalReportStatus =>
  typeof value === 'string' && (EXTERNAL_GOAL_REPORT_STATUSES as readonly string[]).includes(value)

const toSessionRecord = (row: ExternalGoalSessionRow): ExternalGoalSession => ({
  closedAt: row.closed_at,
  context: JSON.parse(row.context_json) as unknown,
  createdAt: row.created_at,
  goal: row.goal,
  id: row.id,
  source: row.source,
  status: row.status,
  summary: row.summary,
  title: row.title,
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
})

const toEventRecord = (row: ExternalGoalEventRow): ExternalGoalEvent => ({
  artifacts: JSON.parse(row.artifacts_json) as string[],
  body: row.body,
  createdAt: row.created_at,
  goalId: row.goal_id,
  id: row.id,
  kind: row.kind,
  sequence: row.sequence,
  status: row.status,
  workspaceId: row.workspace_id,
})

const deriveTitle = (goal: string): string => {
  const firstLine = goal
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? 'External goal').slice(0, 120)
}

export const createExternalGoalStore = (db: Database) => {
  const getSession = (goalId: string): ExternalGoalSession | undefined => {
    const row = db.prepare('SELECT * FROM external_goal_sessions WHERE id = ?').get(goalId) as
      | ExternalGoalSessionRow
      | undefined
    return row ? toSessionRecord(row) : undefined
  }

  const listEventsAfter = (goalId: string, cursor = 0): ExternalGoalEvent[] =>
    (
      db
        .prepare(
          `SELECT *
           FROM external_goal_events
           WHERE goal_id = ? AND sequence > ?
           ORDER BY sequence ASC`
        )
        .all(goalId, cursor) as ExternalGoalEventRow[]
    ).map(toEventRecord)

  const getLatestSequence = (goalId: string): number => {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM external_goal_events WHERE goal_id = ?'
      )
      .get(goalId) as { sequence: number } | undefined
    return row?.sequence ?? 0
  }

  const insertEvent = (
    session: ExternalGoalSession,
    input: AppendExternalGoalEventInput
  ): ExternalGoalEvent => {
    const sequence = getLatestSequence(input.goalId) + 1
    const now = Date.now()
    const event: ExternalGoalEvent = {
      artifacts: input.artifacts ?? [],
      body: input.body,
      createdAt: now,
      goalId: session.id,
      id: randomUUID(),
      kind: input.kind,
      sequence,
      status: input.status ?? null,
      workspaceId: session.workspaceId,
    }
    db.prepare(
      `INSERT INTO external_goal_events (
          id,
          goal_id,
          workspace_id,
          sequence,
          kind,
          status,
          body,
          artifacts_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.goalId,
      event.workspaceId,
      event.sequence,
      event.kind,
      event.status,
      event.body,
      JSON.stringify(event.artifacts),
      event.createdAt
    )

    if (input.sessionStatus) {
      db.prepare(
        `UPDATE external_goal_sessions
           SET status = ?, updated_at = ?, closed_at = ?
           WHERE id = ?`
      ).run(
        input.sessionStatus,
        now,
        CLOSED_STATUSES.has(input.sessionStatus) ? now : null,
        session.id
      )
    } else {
      db.prepare('UPDATE external_goal_sessions SET updated_at = ? WHERE id = ?').run(
        now,
        session.id
      )
    }

    return event
  }

  const appendEvent = (input: AppendExternalGoalEventInput): ExternalGoalEvent => {
    return db.transaction(() => {
      const session = getSession(input.goalId)
      if (!session) throw new Error(`External goal not found: ${input.goalId}`)
      return insertEvent(session, input)
    })()
  }

  const createSession = (input: CreateExternalGoalInput) => {
    return db.transaction(() => {
      const now = Date.now()
      const session: ExternalGoalSession = {
        closedAt: null,
        context: input.context ?? null,
        createdAt: now,
        goal: input.goal,
        id: `goal_${randomUUID()}`,
        source: input.source,
        status: 'open',
        summary: null,
        title: deriveTitle(input.goal),
        updatedAt: now,
        workspaceId: input.workspaceId,
      }
      db.prepare(
        `INSERT INTO external_goal_sessions (
          id,
          workspace_id,
          source,
          status,
          goal,
          context_json,
          title,
          summary,
          created_at,
          updated_at,
          closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        session.id,
        session.workspaceId,
        session.source,
        session.status,
        session.goal,
        JSON.stringify(session.context),
        session.title,
        session.summary,
        session.createdAt,
        session.updatedAt,
        session.closedAt
      )
      const event = insertEvent(session, {
        body: input.goal,
        goalId: session.id,
        kind: 'goal_started',
        status: 'open',
      })
      return { event, session }
    })()
  }

  const deleteWorkspaceGoals = (workspaceId: string) => {
    db.prepare('DELETE FROM external_goal_events WHERE workspace_id = ?').run(workspaceId)
    db.prepare('DELETE FROM external_goal_sessions WHERE workspace_id = ?').run(workspaceId)
  }

  return {
    appendEvent,
    createSession,
    deleteWorkspaceGoals,
    getLatestSequence,
    getSession,
    listEventsAfter,
  }
}

export type ExternalGoalStore = ReturnType<typeof createExternalGoalStore>
