import type { DispatchMessageRecord } from '../shared/team-collaboration.js'
import type { TeamListItem } from '../shared/types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { RemoteAuditRecord } from './remote-audit-store.js'
import { serializeDispatchMessage } from './routes-team-messages.js'
import type { RuntimeStore } from './runtime-store.js'

const MAX_RECENT_ACTIVITY = 12
const MAX_REMOTE_ATTENTION_SCAN = 25
const MAX_REMOTE_ATTENTION_ITEMS = 3
const MAX_WAITING_REPORT_ATTENTION_ITEMS = 3
const PREVIEW_MAX = 180
const TERMINAL_HINT_MAX = 120
// A quiet dispatch is surfaced as an FYI, never an alarm: Hive deliberately
// has no timeout/stall detection (design §3.6 — the user judges a silent
// worker). Ordinary coding tasks routinely run past any threshold we could
// pick, so the age is generous and the severity stays at `info`.
const WAITING_REPORT_MS = 10 * 60 * 1000

const truncateText = (text: string | null, max: number): string | null => {
  if (!text) return null
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return null
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

const dispatchTimestamp = (dispatch: DispatchRecord): number =>
  dispatch.reportedAt ?? dispatch.submittedAt ?? dispatch.deliveredAt ?? dispatch.createdAt

const dispatchActivityKind = (status: DispatchRecord['status']) => {
  if (status === 'reported') return 'reported'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'submitted') return 'submitted'
  return 'queued'
}

const workerName = (workersById: Map<string, TeamListItem>, workerId: string): string | null =>
  workersById.get(workerId)?.name ?? null

const workspaceIdFromEndpoint = (endpoint: string | null): string | null => {
  const match = endpoint?.match(/^\/api\/(?:ui\/)?workspaces\/([^/?#]+)/u)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

const remoteAuditBelongsToWorkspace = (entry: RemoteAuditRecord, workspaceId: string): boolean => {
  if (entry.workspaceId !== null) return entry.workspaceId === workspaceId
  const endpointWorkspaceId = workspaceIdFromEndpoint(entry.endpoint)
  return endpointWorkspaceId === null || endpointWorkspaceId === workspaceId
}

const waitingForReportAge = (dispatch: DispatchRecord, now: number): number | null => {
  if (dispatch.status !== 'submitted' || dispatch.submittedAt === null) return null
  const age = now - dispatch.submittedAt
  return age >= WAITING_REPORT_MS ? age : null
}

const buildAttentionItems = (input: {
  now: number
  messages: DispatchMessageRecord[]
  openDispatches: DispatchRecord[]
  store: RuntimeStore
  waitingReportDispatches: DispatchRecord[]
  workers: TeamListItem[]
  workspaceId: string
}) => {
  const attention: Array<Record<string, unknown>> = []
  for (const message of input.messages) {
    const kind =
      message.deliveryState === 'queued'
        ? 'message_delivery_pending'
        : message.kind === 'question'
          ? 'question_waiting_answer'
          : null
    if (!kind) continue
    attention.push({
      kind,
      severity: 'warning',
      dispatch_id: message.dispatchId,
      message_id: message.id,
      worker_id: message.recipientAgentId,
    })
  }

  const workersById = new Map(input.workers.map((worker) => [worker.id, worker]))
  if (input.workers.length === 0) {
    attention.push({ kind: 'no_workers', severity: 'info' })
  }

  for (const worker of input.workers) {
    if (worker.status !== 'stopped' || worker.pendingTaskCount <= 0) continue
    const openCount = input.openDispatches.filter(
      (dispatch) => dispatch.toAgentId === worker.id
    ).length
    attention.push({
      kind: 'stopped_with_queue',
      open_dispatches: openCount,
      pending_task_count: worker.pendingTaskCount,
      severity: 'warning',
      worker_id: worker.id,
      worker_name: worker.name,
    })
  }

  for (const dispatch of input.waitingReportDispatches.slice(
    0,
    MAX_WAITING_REPORT_ATTENTION_ITEMS
  )) {
    const age = waitingForReportAge(dispatch, input.now)
    if (age === null) continue
    attention.push({
      dispatch_id: dispatch.id,
      kind: 'dispatch_waiting_report',
      minutes_ago: Math.floor(age / 60_000),
      severity: 'info',
      submitted_at: dispatch.submittedAt,
      worker_id: dispatch.toAgentId,
      worker_name: workerName(workersById, dispatch.toAgentId),
    })
  }

  const remoteProblems = input.store
    .getRemoteAuditStore()
    .list(MAX_REMOTE_ATTENTION_SCAN)
    .filter(
      (entry) => entry.result !== 'ok' && remoteAuditBelongsToWorkspace(entry, input.workspaceId)
    )
    .slice(0, MAX_REMOTE_ATTENTION_ITEMS)

  for (const entry of remoteProblems) {
    attention.push({
      action: entry.action,
      endpoint: entry.endpoint,
      kind: entry.result === 'error' ? 'remote_error' : 'remote_rejected',
      reason: entry.rejectReason,
      severity: entry.result === 'error' ? 'error' : 'warning',
      ts: entry.ts,
    })
  }

  return attention
}

const serializeDispatchEvidence = (
  dispatch: DispatchRecord,
  workersById: Map<string, TeamListItem>,
  includeTextEvidence: boolean
) => {
  const textEvidence = includeTextEvidence
    ? {
        label: dispatch.label,
        phase: dispatch.phase,
        report_preview: truncateText(dispatch.reportText, PREVIEW_MAX),
        task_preview: truncateText(dispatch.text, PREVIEW_MAX),
      }
    : {
        // Workflow-authored label/phase are task-title-class free text (the
        // first-party guidance even puts file paths in labels), so the
        // shareable support bundle reduces them to presence flags.
        has_label: dispatch.label !== null,
        has_phase: dispatch.phase !== null,
      }

  return {
    created_at: dispatch.createdAt,
    id: dispatch.id,
    ...textEvidence,
    status: dispatch.status,
    submitted_at: dispatch.submittedAt,
    timestamp: dispatchTimestamp(dispatch),
    to_agent_id: dispatch.toAgentId,
    to_worker_name: workerName(workersById, dispatch.toAgentId),
    workflow_run_id: dispatch.workflowRunId,
  }
}

export const buildActionCenterSummary = (input: {
  includeTextEvidence?: boolean
  now?: number
  store: RuntimeStore
  workspaceId: string
}) => {
  const includeTextEvidence = input.includeTextEvidence !== false
  const now = input.now ?? Date.now()
  const messages = input.store.listActionableDispatchMessages(input.workspaceId)
  const workers = input.store.listWorkers(input.workspaceId)
  const workersById = new Map(workers.map((worker) => [worker.id, worker]))
  const openDispatches = input.store.listOpenDispatches(input.workspaceId)
  const waitingReportDispatches = openDispatches.filter(
    (dispatch) => waitingForReportAge(dispatch, now) !== null
  )
  const recentDispatches = input.store.listRecentDispatches(input.workspaceId, MAX_RECENT_ACTIVITY)

  return {
    attention: buildAttentionItems({
      now,
      messages,
      openDispatches,
      store: input.store,
      waitingReportDispatches,
      workers,
      workspaceId: input.workspaceId,
    }),
    recent_dispatch_messages: includeTextEvidence
      ? input.store
          .listRecentDispatchMessages(input.workspaceId, 12)
          .reverse()
          .map(serializeDispatchMessage)
      : [],
    generated_at: now,
    recent_activity: recentDispatches.map((dispatch) => ({
      ...serializeDispatchEvidence(dispatch, workersById, includeTextEvidence),
      kind: dispatchActivityKind(dispatch.status),
    })),
    summary: {
      idle_workers: workers.filter((worker) => worker.status === 'idle').length,
      open_dispatches: openDispatches.length,
      recent_reports: recentDispatches.filter((dispatch) => dispatch.status === 'reported').length,
      stopped_with_queue: workers.filter(
        (worker) => worker.status === 'stopped' && worker.pendingTaskCount > 0
      ).length,
      stopped_workers: workers.filter((worker) => worker.status === 'stopped').length,
      total_workers: workers.length,
      waiting_reports: waitingReportDispatches.length,
      working_workers: workers.filter((worker) => worker.status === 'working').length,
    },
    workers: workers.map((worker) => {
      const workerOpenDispatches = openDispatches.filter(
        (dispatch) => dispatch.toAgentId === worker.id
      )
      const latestReport =
        recentDispatches.find(
          (dispatch) => dispatch.toAgentId === worker.id && dispatch.status === 'reported'
        ) ?? null
      const terminalHint = includeTextEvidence
        ? {
            terminal_hint: truncateText(
              input.store.getLastPtyLineForAgent(input.workspaceId, worker.id),
              TERMINAL_HINT_MAX
            ),
          }
        : {}

      return {
        current_dispatch: workerOpenDispatches[0]
          ? serializeDispatchEvidence(workerOpenDispatches[0], workersById, includeTextEvidence)
          : null,
        id: worker.id,
        latest_report: latestReport
          ? serializeDispatchEvidence(latestReport, workersById, includeTextEvidence)
          : null,
        name: worker.name,
        pending_task_count: worker.pendingTaskCount,
        role: worker.role,
        status: worker.status,
        ...terminalHint,
      }
    }),
    workspace_id: input.workspaceId,
  }
}
