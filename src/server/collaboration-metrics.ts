import type {
  CollaborationMetrics,
  CollaborationMetricsAggregate,
  CollaborationPercentiles,
} from '../shared/types.js'
import type { Database } from './sqlite.js'

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_COLLABORATION_WINDOW_DAYS = 30
export const COLLABORATION_DELIVERABLE_CAP = 200

interface CollaborationDispatchRow {
  cancelled: number
  created_at: number
  delivered_at: number | null
  dispatch_payload_bytes: number | null
  id: string
  message_count: number
  report_payload_bytes: number | null
  reported: number
  reported_at: number | null
  root_dispatch_id: string
}

const asNumber = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  const lower = sorted[low]
  const upper = sorted[high]
  if (lower === undefined) return null
  if (upper === undefined || low === high) return lower
  return lower + (upper - lower) * (rank - low)
}

const summarize = (values: number[]): CollaborationPercentiles => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
})

const average = (total: number, count: number): number | null =>
  count === 0 ? null : total / count

export const emptyCollaborationMetrics = (
  workspaceId: string,
  windowDays: number
): CollaborationMetrics => ({
  cancelled_count: 0,
  deliverables: [],
  delivered_to_reported_ms: { p50: null, p95: null },
  dispatch_count: 0,
  dispatch_payload_bytes: { avg: null, total: 0 },
  message_count: 0,
  report_payload_bytes: { avg: null, total: 0 },
  reported_count: 0,
  send_to_delivered_ms: { p50: null, p95: null },
  window_days: windowDays,
  workspace_id: workspaceId,
})

export const toCollaborationAggregate = (
  metrics: CollaborationMetrics
): CollaborationMetricsAggregate => {
  const { deliverables: _deliverables, ...aggregate } = metrics
  return aggregate
}

export const queryCollaborationMetrics = (
  db: Database,
  workspaceId: string,
  windowDays = DEFAULT_COLLABORATION_WINDOW_DAYS,
  now = Date.now()
): CollaborationMetrics => {
  const empty = emptyCollaborationMetrics(workspaceId, windowDays)
  // A broken query must surface as a 500, not as "no collaboration cost".
  const rows = db
    .prepare(
      `SELECT
           d.id,
           COALESCE(d.root_dispatch_id, d.id) AS root_dispatch_id,
           d.created_at,
           d.delivered_at,
           d.reported_at,
           d.dispatch_payload_bytes,
           d.report_payload_bytes,
           CASE WHEN d.status = 'reported' THEN 1 ELSE 0 END AS reported,
           CASE WHEN d.status = 'cancelled' THEN 1 ELSE 0 END AS cancelled,
           (SELECT COUNT(*) FROM dispatch_messages m WHERE m.dispatch_id = d.id) AS message_count
         FROM dispatches d
         WHERE d.workspace_id = ? AND d.created_at >= ?
         ORDER BY d.created_at ASC, d.sequence ASC`
    )
    .all(workspaceId, now - windowDays * DAY_MS) as CollaborationDispatchRow[]

  if (rows.length === 0) return empty

  const sendToDelivered: number[] = []
  const deliveredToReported: number[] = []
  let dispatchPayloadTotal = 0
  let dispatchPayloadMeasured = 0
  let reportPayloadTotal = 0
  let reportPayloadMeasured = 0
  let reportedCount = 0
  let cancelledCount = 0
  let messageCount = 0
  const deliverableMap = new Map<
    string,
    {
      dispatch_count: number
      first_created_at: number
      injected_bytes: number
      last_reported_at: number | null
      message_count: number
    }
  >()

  for (const row of rows) {
    reportedCount += row.reported
    cancelledCount += row.cancelled
    messageCount += asNumber(row.message_count)
    const dispatchBytes = asNumber(row.dispatch_payload_bytes)
    const reportBytes = asNumber(row.report_payload_bytes)
    if (row.dispatch_payload_bytes !== null) {
      dispatchPayloadTotal += row.dispatch_payload_bytes
      dispatchPayloadMeasured += 1
    }
    if (row.report_payload_bytes !== null) {
      reportPayloadTotal += row.report_payload_bytes
      reportPayloadMeasured += 1
    }
    // delivered_at stays NULL when a report closes the row before the PTY
    // write resolves ("reported before delivery confirmed"). Skip those
    // rows so durations are never computed from a missing stamp.
    if (row.delivered_at !== null) {
      sendToDelivered.push(row.delivered_at - row.created_at)
      if (row.reported_at !== null) {
        deliveredToReported.push(row.reported_at - row.delivered_at)
      }
    }
    const rootId = row.root_dispatch_id || row.id
    const existing = deliverableMap.get(rootId)
    if (!existing) {
      deliverableMap.set(rootId, {
        dispatch_count: 1,
        first_created_at: row.created_at,
        injected_bytes: dispatchBytes + reportBytes,
        last_reported_at: row.reported_at,
        message_count: asNumber(row.message_count),
      })
      continue
    }
    existing.dispatch_count += 1
    existing.message_count += asNumber(row.message_count)
    existing.injected_bytes += dispatchBytes + reportBytes
    if (row.created_at < existing.first_created_at) existing.first_created_at = row.created_at
    if (row.reported_at !== null) {
      existing.last_reported_at =
        existing.last_reported_at === null
          ? row.reported_at
          : Math.max(existing.last_reported_at, row.reported_at)
    }
  }

  return {
    cancelled_count: cancelledCount,
    deliverables: [...deliverableMap.entries()]
      .map(([rootDispatchId, item]) => ({
        dispatch_count: item.dispatch_count,
        first_created_at: item.first_created_at,
        injected_bytes: item.injected_bytes,
        last_reported_at: item.last_reported_at,
        message_count: item.message_count,
        root_dispatch_id: rootDispatchId,
        wall_clock_ms:
          item.last_reported_at === null ? null : item.last_reported_at - item.first_created_at,
      }))
      .sort((left, right) => right.first_created_at - left.first_created_at)
      .slice(0, COLLABORATION_DELIVERABLE_CAP),
    delivered_to_reported_ms: summarize(deliveredToReported),
    dispatch_count: rows.length,
    dispatch_payload_bytes: {
      avg: average(dispatchPayloadTotal, dispatchPayloadMeasured),
      total: dispatchPayloadTotal,
    },
    message_count: messageCount,
    report_payload_bytes: {
      avg: average(reportPayloadTotal, reportPayloadMeasured),
      total: reportPayloadTotal,
    },
    reported_count: reportedCount,
    send_to_delivered_ms: summarize(sendToDelivered),
    window_days: windowDays,
    workspace_id: workspaceId,
  }
}
