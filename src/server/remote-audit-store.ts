import type { Database } from './sqlite.js'

// Remote-access audit trail (schema v23). The tunnel/bridge layer is the single
// collection point: every remote HTTP request, WS-input chunk, lifecycle event
// and rejection lands here via `enqueue`. Writes are async + non-blocking so
// auditing never stalls frame forwarding — `enqueue` only appends to an
// in-memory buffer and schedules a microtask flush; the actual INSERT happens
// off the hot path (audit spec: "异步不阻塞转发").
//
// Recording, not enforcing: a row is written whether the request was bridged or
// rejected. The reject_reason field is what makes the adversarial security
// tests bite — an off-whitelist path / forged secret / revoked device must
// produce a row whose reason names the actual failure, not just "rejected".

export type RemoteAuditResult = 'ok' | 'rejected' | 'error'

// Coarse action categories. NOT a full URL — `endpoint` carries the whitelisted
// path. Keep this a fixed vocabulary so the Settings audit view can group/filter
// without parsing free text.
export type RemoteAuditAction =
  | 'http' // a bridged /api/* request
  | 'ws_input' // terminal / tasks stdin chunk (summarised, never full text)
  | 'ws_open' // a /ws/* stream was bridged
  | 'session_open' // remote session established
  | 'session_close' // remote session torn down
  | 'revoke' // device revoked
  | 'reject' // a frame/path was refused before any loopback request

export interface RemoteAuditEvent {
  /** M1 session device id. Audit/revocation tag only — never a permission branch. */
  deviceId?: string | null
  /** Coarse category (see RemoteAuditAction). */
  action: RemoteAuditAction
  /** Whitelisted path for http/ws actions (`/api/...`, `/ws/...`); omit otherwise. */
  endpoint?: string | null
  /** Affected workspace, when the action is scoped to one. */
  workspaceId?: string | null
  result: RemoteAuditResult
  /** Required-in-spirit on a rejection: the concrete reason (off-whitelist, revoked, …). */
  rejectReason?: string | null
  /** WS-input byte count. The full chunk is NEVER stored. */
  byteCount?: number | null
  /** Short truncated preview of WS input. Bounded here, not by the caller. */
  preview?: string | null
}

export interface RemoteAuditRecord {
  id: number
  deviceId: string | null
  ts: number
  workspaceId: string | null
  action: string
  endpoint: string | null
  result: string
  rejectReason: string | null
  byteCount: number | null
  preview: string | null
}

// stdin previews are bounded so a paste of a megabyte of secrets can't end up in
// the audit table. byte_count carries the real size; preview is just enough to
// recognise the input in the Settings stream.
export const AUDIT_PREVIEW_MAX = 120

const truncatePreview = (preview: string | null | undefined): string | null => {
  if (preview === null || preview === undefined) return null
  if (preview.length <= AUDIT_PREVIEW_MAX) return preview
  return `${preview.slice(0, AUDIT_PREVIEW_MAX)}…`
}

export const createRemoteAuditStore = (db: Database) => {
  const insert = db.prepare(
    `INSERT INTO remote_audit
       (remote_device_id, ts, workspace_id, action, endpoint, result, reject_reason, byte_count, preview)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const listStmt = db.prepare(
    `SELECT id, remote_device_id, ts, workspace_id, action, endpoint, result, reject_reason, byte_count, preview
       FROM remote_audit
      ORDER BY id DESC
      LIMIT ?`
  )
  const listForDeviceStmt = db.prepare(
    `SELECT id, remote_device_id, ts, workspace_id, action, endpoint, result, reject_reason, byte_count, preview
       FROM remote_audit
      WHERE remote_device_id = ?
      ORDER BY id DESC
      LIMIT ?`
  )

  // Pending events buffered between flushes. enqueue() never touches SQLite
  // directly — it appends here and arms a single microtask drain, so a burst of
  // terminal keystrokes coalesces into one transaction instead of N.
  const pending: Array<RemoteAuditEvent & { ts: number }> = []
  let flushScheduled = false
  let draining: Promise<void> | null = null

  const writePending = (): void => {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    const tx = db.transaction((events: Array<RemoteAuditEvent & { ts: number }>) => {
      for (const e of events) {
        insert.run(
          e.deviceId ?? null,
          e.ts,
          e.workspaceId ?? null,
          e.action,
          e.endpoint ?? null,
          e.result,
          e.rejectReason ?? null,
          typeof e.byteCount === 'number' ? e.byteCount : null,
          truncatePreview(e.preview)
        )
      }
    })
    tx(batch)
  }

  const scheduleFlush = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    draining = new Promise<void>((resolve) => {
      // queueMicrotask keeps the write off the forwarding call stack while
      // still landing before the event loop yields to I/O, so audit rows for a
      // request are durable well before the response round-trips.
      queueMicrotask(() => {
        flushScheduled = false
        try {
          writePending()
        } catch {
          // A failed audit write must not crash the tunnel. Drop the batch and
          // keep forwarding; losing an audit row is strictly better than
          // dropping a user's terminal input.
        }
        resolve()
      })
    })
  }

  const mapRow = (row: {
    id: number
    remote_device_id: string | null
    ts: number
    workspace_id: string | null
    action: string
    endpoint: string | null
    result: string
    reject_reason: string | null
    byte_count: number | null
    preview: string | null
  }): RemoteAuditRecord => ({
    id: row.id,
    deviceId: row.remote_device_id,
    ts: row.ts,
    workspaceId: row.workspace_id,
    action: row.action,
    endpoint: row.endpoint,
    result: row.result,
    rejectReason: row.reject_reason,
    byteCount: row.byte_count,
    preview: row.preview,
  })

  return {
    /**
     * Record an audit event. Returns immediately; the row is written on a
     * later microtask. This is the ONLY method the tunnel calls on the hot path.
     */
    enqueue(event: RemoteAuditEvent, ts: number = Date.now()): void {
      pending.push({ ...event, ts })
      scheduleFlush()
    },

    /**
     * Drain the buffer synchronously and await the pending write. Tests await
     * this to assert rows deterministically; shutdown calls it to avoid losing
     * the tail of the buffer. Idempotent when there's nothing pending.
     */
    async flush(): Promise<void> {
      // Settle any already-scheduled drain first, then force-write whatever the
      // caller enqueued after it was scheduled (or never scheduled at all).
      if (draining) await draining
      writePending()
    },

    /** Newest-first audit rows, capped at `limit`. Backs the Settings stream. */
    list(limit = 100): RemoteAuditRecord[] {
      writePending()
      return (listStmt.all(limit) as Parameters<typeof mapRow>[0][]).map(mapRow)
    },

    /** Newest-first rows for one device. Used by the device-detail view. */
    listForDevice(deviceId: string, limit = 100): RemoteAuditRecord[] {
      writePending()
      return (listForDeviceStmt.all(deviceId, limit) as Parameters<typeof mapRow>[0][]).map(mapRow)
    },
  }
}

export type RemoteAuditStore = ReturnType<typeof createRemoteAuditStore>
