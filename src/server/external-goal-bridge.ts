import { EventEmitter } from 'node:events'

import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type {
  ExternalGoalEvent,
  ExternalGoalReportStatus,
  ExternalGoalSession,
  ExternalGoalStore,
} from './external-goal-store.js'
import { escapeHiveEnvelopeAttribute, escapeHiveEnvelopeText } from './hive-envelope-escape.js'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  PtyInactiveError,
} from './http-errors.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { getOrchestratorId } from './workspace-store-support.js'

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 120_000

interface ExternalGoalBridgePorts {
  deliverToOrchestrator: (workspaceId: string, text: string) => Promise<void>
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => unknown | undefined
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getWorkspaceSnapshot: (workspaceId: string) => {
    agents: AgentSummary[]
    summary: WorkspaceSummary
  }
  goalStore: ExternalGoalStore
  listWorkers: (workspaceId: string) => TeamListItem[]
  listWorkspaces: () => WorkspaceSummary[]
}

export interface ExternalGoalStartInput {
  context?: unknown
  goal: string
  source: string
  timeoutHintMs?: number
  workspaceId: string
}

export interface ExternalGoalContinueInput {
  context?: unknown
  goalId: string
  message: string
}

export interface ExternalGoalReportInput {
  artifacts?: string[]
  body: string
  fromAgentId: string
  goalId: string
  status: ExternalGoalReportStatus
  workspaceId: string
}

export interface ExternalGoalWaitInput {
  cursor?: number
  goalId: string
  timeoutMs?: number
}

export interface ExternalGoalCancelInput {
  goalId: string
  reason: string
}

export class ExternalGoalDeliveryError extends PtyInactiveError {
  readonly cursor: number
  readonly goalId: string
  readonly status: ExternalGoalSession['status']

  constructor(input: {
    cursor: number
    goalId: string
    message: string
    status: 'cancelled' | 'failed'
  }) {
    super(input.message)
    this.name = 'ExternalGoalDeliveryError'
    this.cursor = input.cursor
    this.goalId = input.goalId
    this.status = input.status
  }
}

const reportEventKind = (status: ExternalGoalReportStatus): ExternalGoalEvent['kind'] => {
  if (status === 'progress') return 'progress_reported'
  if (status === 'done') return 'goal_done'
  if (status === 'blocked') return 'goal_blocked'
  return 'goal_failed'
}

const reportSessionStatus = (status: ExternalGoalReportStatus): ExternalGoalSession['status'] => {
  if (status === 'progress') return 'in_progress'
  return status
}

const closedForReport = new Set<ExternalGoalSession['status']>([
  'blocked',
  'done',
  'failed',
  'cancelled',
])

const boundedTimeout = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestError('timeout_ms must be a non-negative number')
  }
  return Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS)
}

const normalizedCursor = (value: number | undefined): number => {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestError('cursor must be a non-negative integer')
  }
  return value
}

const requireSession = (goalStore: ExternalGoalStore, goalId: string): ExternalGoalSession => {
  const session = goalStore.getSession(goalId)
  if (!session) throw new HttpError(404, `External goal not found: ${goalId}`)
  return session
}

const contextLines = (context: unknown): string[] => {
  if (context === undefined || context === null) return []
  const body = typeof context === 'string' ? context : JSON.stringify(context, null, 2)
  if (!body.trim()) return []
  return ['', 'Context:', escapeHiveEnvelopeText(body)]
}

const buildExternalGoalPayload = (session: ExternalGoalSession): string =>
  [
    `<hive-message kind="external-goal" source="${escapeHiveEnvelopeAttribute(
      session.source
    )}" goal_id="${escapeHiveEnvelopeAttribute(session.id)}">`,
    '',
    'You received an external Supervisor goal.',
    '',
    'Rules:',
    '- You are still the Hive Orchestrator for this workspace.',
    '- Use current Hive members through `team list` and `team send`.',
    '- Do not report final completion to the user directly; report to the external Supervisor with:',
    `  team goal report --goal ${session.id} --status done --stdin`,
    '- Use status `progress` for meaningful phase updates.',
    '- Use status `blocked` when you need an external decision.',
    '',
    'Goal:',
    escapeHiveEnvelopeText(session.goal),
    ...contextLines(session.context),
    '</hive-message>',
    '',
  ].join('\n')

const buildExternalGoalContinuePayload = (
  session: ExternalGoalSession,
  message: string,
  context: unknown
): string =>
  [
    `<hive-message kind="external-goal-continue" goal_id="${escapeHiveEnvelopeAttribute(
      session.id
    )}">`,
    '',
    'The external Supervisor added context for this goal.',
    '',
    'Continue coordinating through Hive members as needed. Report meaningful updates with:',
    `  team goal report --goal ${session.id} --status progress --stdin`,
    '',
    'Message:',
    escapeHiveEnvelopeText(message),
    ...contextLines(context),
    '</hive-message>',
    '',
  ].join('\n')

const buildExternalGoalCancelPayload = (session: ExternalGoalSession, reason: string): string =>
  [
    `<hive-message kind="external-goal-cancel" goal_id="${escapeHiveEnvelopeAttribute(
      session.id
    )}">`,
    '',
    'Stop coordinating this external goal. Do not send more goal reports for it.',
    '',
    'MVP note: Hive did not automatically cancel member dispatches. Decide whether any open dispatches should be cancelled with `team cancel`.',
    '',
    'Reason:',
    escapeHiveEnvelopeText(reason),
    '</hive-message>',
    '',
  ].join('\n')

export const createExternalGoalBridge = ({
  deliverToOrchestrator,
  getActiveRunByAgentId,
  getAgent,
  getWorkspaceSnapshot,
  goalStore,
  listWorkers,
  listWorkspaces,
}: ExternalGoalBridgePorts) => {
  const events = new EventEmitter()
  events.setMaxListeners(200)

  const notify = (goalId: string) => events.emit(goalId)

  const waitForNewEvent = (goalId: string, timeoutMs: number): Promise<void> => {
    if (timeoutMs <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const onEvent = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        events.off(goalId, onEvent)
        resolve()
      }, timeoutMs)
      timer.unref?.()
      events.once(goalId, onEvent)
    })
  }

  const appendAndNotify = (input: Parameters<typeof goalStore.appendEvent>[0]) => {
    const event = goalStore.appendEvent(input)
    notify(input.goalId)
    return event
  }

  const deliverOrMarkFailed = async (session: ExternalGoalSession, text: string) => {
    try {
      await deliverToOrchestrator(session.workspaceId, text)
    } catch (error) {
      const event = appendAndNotify({
        body: error instanceof Error ? error.message : String(error),
        goalId: session.id,
        kind: 'delivery_failed',
        sessionStatus: 'failed',
        status: 'failed',
      })
      throw new ExternalGoalDeliveryError({
        cursor: event.sequence,
        goalId: session.id,
        message: `orchestrator_not_running: could not deliver external goal ${session.id}`,
        status: 'failed',
      })
    }
  }

  return {
    listWorkspaces,
    inspectWorkspace(input: { workspaceId: string }) {
      const snapshot = getWorkspaceSnapshot(input.workspaceId)
      const orchestratorId = getOrchestratorId(input.workspaceId)
      const orchestrator = getAgent(input.workspaceId, orchestratorId)
      return {
        workspace: snapshot.summary,
        orchestrator: {
          id: orchestrator.id,
          name: orchestrator.name,
          status: orchestrator.status,
          active_run: Boolean(getActiveRunByAgentId(input.workspaceId, orchestrator.id)),
        },
        members: listWorkers(input.workspaceId).map((worker) => serializeTeamListItem(worker)),
      }
    },
    async startGoal(input: ExternalGoalStartInput) {
      getWorkspaceSnapshot(input.workspaceId)
      const { session } = goalStore.createSession({
        context: input.context,
        goal: input.goal,
        source: input.source,
        workspaceId: input.workspaceId,
      })
      notify(session.id)
      await deliverOrMarkFailed(session, buildExternalGoalPayload(session))
      const delivered = appendAndNotify({
        body: 'External goal delivered to Orchestrator.',
        goalId: session.id,
        kind: 'goal_delivered',
        sessionStatus: 'in_progress',
        status: 'in_progress',
      })
      const current = requireSession(goalStore, session.id)
      return {
        cursor: delivered.sequence,
        events: goalStore.listEventsAfter(session.id, 0),
        goalId: session.id,
        session: current,
        status: current.status,
      }
    },
    async continueGoal(input: ExternalGoalContinueInput) {
      const session = requireSession(goalStore, input.goalId)
      if (session.status === 'cancelled') {
        throw new ConflictError(`External goal is cancelled: ${input.goalId}`)
      }
      const event = appendAndNotify({
        body: input.message,
        goalId: session.id,
        kind: 'goal_continued',
        sessionStatus: 'in_progress',
        status: 'in_progress',
      })
      await deliverOrMarkFailed(
        { ...session, status: 'in_progress' },
        buildExternalGoalContinuePayload(session, input.message, input.context)
      )
      const current = requireSession(goalStore, session.id)
      return { cursor: event.sequence, event, session: current, status: current.status }
    },
    reportGoal(input: ExternalGoalReportInput) {
      const session = requireSession(goalStore, input.goalId)
      if (session.workspaceId !== input.workspaceId) {
        throw new HttpError(404, `External goal not found in workspace: ${input.goalId}`)
      }
      if (input.fromAgentId !== getOrchestratorId(input.workspaceId)) {
        throw new ForbiddenError('Only the workspace Orchestrator can report external goals')
      }
      if (closedForReport.has(session.status)) {
        throw new ConflictError(`External goal is not accepting reports: ${input.goalId}`)
      }
      const event = appendAndNotify({
        body: input.body,
        goalId: session.id,
        kind: reportEventKind(input.status),
        sessionStatus: reportSessionStatus(input.status),
        status: input.status,
        ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
      })
      const current = requireSession(goalStore, session.id)
      return { cursor: event.sequence, event, session: current, status: current.status }
    },
    async waitGoal(input: ExternalGoalWaitInput) {
      const session = requireSession(goalStore, input.goalId)
      const cursor = normalizedCursor(input.cursor)
      const existing = goalStore.listEventsAfter(session.id, cursor)
      if (existing.length > 0) {
        const current = requireSession(goalStore, session.id)
        return {
          cursor: existing.at(-1)?.sequence ?? cursor,
          events: existing,
          goalId: session.id,
          status: current.status,
        }
      }

      await waitForNewEvent(session.id, boundedTimeout(input.timeoutMs))
      const eventsAfterWait = goalStore.listEventsAfter(session.id, cursor)
      const current = requireSession(goalStore, session.id)
      return {
        cursor:
          eventsAfterWait.at(-1)?.sequence ??
          Math.max(cursor, goalStore.getLatestSequence(session.id)),
        events: eventsAfterWait,
        goalId: session.id,
        status: current.status,
      }
    },
    async cancelGoal(input: ExternalGoalCancelInput) {
      const session = requireSession(goalStore, input.goalId)
      if (closedForReport.has(session.status) && session.status !== 'blocked') {
        throw new ConflictError(
          `External goal cannot be cancelled from ${session.status}: ${input.goalId}`
        )
      }
      const event = appendAndNotify({
        body: input.reason,
        goalId: session.id,
        kind: 'goal_cancelled',
        sessionStatus: 'cancelled',
        status: 'cancelled',
      })
      try {
        await deliverToOrchestrator(
          session.workspaceId,
          buildExternalGoalCancelPayload(session, input.reason)
        )
      } catch (error) {
        const deliveryFailure = appendAndNotify({
          body: error instanceof Error ? error.message : String(error),
          goalId: session.id,
          kind: 'delivery_failed',
          sessionStatus: 'cancelled',
          status: 'cancelled',
        })
        throw new ExternalGoalDeliveryError({
          cursor: deliveryFailure.sequence,
          goalId: session.id,
          message: `orchestrator_not_running: cancelled external goal ${session.id}, but could not deliver the cancellation notice`,
          status: 'cancelled',
        })
      }
      const current = requireSession(goalStore, session.id)
      return { cursor: event.sequence, event, session: current, status: current.status }
    },
  }
}

export type ExternalGoalBridge = ReturnType<typeof createExternalGoalBridge>
