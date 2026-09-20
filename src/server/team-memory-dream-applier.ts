import { createHash, randomUUID } from 'node:crypto'
import type { MemoryKind, MemoryProcedureRef } from '../shared/team-memory.js'
import type { Database } from './sqlite.js'
import {
  type DreamOperation,
  DreamRunValidationError,
  parseDreamOperations,
} from './team-memory-dream-ops.js'
import { DREAM_RUNNING_STALE_MS, DREAM_STALE_ERROR } from './team-memory-dream-run-store.js'
import {
  type DreamRunRecord,
  type DreamRunReport,
  type DreamRunRow,
  type MemoryEntryRow,
  type MemorySourceRow,
  toDreamRunRecord,
} from './team-memory-dream-types.js'
import type { MemorySourceType } from './team-memory-store.js'

const hashText = (text: string) => createHash('sha256').update(text).digest('hex')
const DREAM_SOURCE_MESSAGE_TYPES = "'user_input', 'send', 'report'"

const excerptFor = (text: string | null) => (text ? [...text].slice(0, 500).join('') : null)

const parseTags = (tags: string | null): string[] => {
  if (!tags) return []
  const parsed = JSON.parse(tags) as unknown
  return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
}

export const createDreamOperationApplier = (db: Database) => {
  const requireWorkspace = (workspaceId: string) => {
    const row = db.prepare('SELECT id FROM workspaces WHERE id = ? LIMIT 1').get(workspaceId) as
      | { id: string }
      | undefined
    if (!row) throw new DreamRunValidationError('Dream workspace no longer exists')
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

  const requireRunningRunRow = (workspaceId: string, runId: string) => {
    const row = db
      .prepare(
        `SELECT *
         FROM dream_runs
         WHERE id = ?
           AND workspace_id = ?
           AND status = 'running'
         LIMIT 1`
      )
      .get(runId, workspaceId) as DreamRunRow | undefined
    if (!row) throw new DreamRunValidationError('Dream run is no longer running')
    return row
  }

  const getMemoryRow = (workspaceId: string, memoryId: string) =>
    db
      .prepare(
        `SELECT *
         FROM memory_entries
         WHERE id = ?
           AND scope = 'workspace'
           AND workspace_id = ?
         LIMIT 1`
      )
      .get(memoryId, workspaceId) as MemoryEntryRow | undefined

  const requireMemoryRow = (workspaceId: string, memoryId: string) => {
    const row = getMemoryRow(workspaceId, memoryId)
    if (!row) throw new DreamRunValidationError('Dream op memory id is outside this workspace')
    return row
  }

  const requireRunMemoryUnchanged = (run: DreamRunRow, row: MemoryEntryRow) => {
    if (row.status !== 'active' || row.updated_at > run.started_at) {
      throw new DreamRunValidationError('Dream op memory changed after this run started')
    }
  }

  const listSourceRows = (memoryId: string) =>
    db
      .prepare(
        `SELECT *
         FROM memory_sources
         WHERE memory_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(memoryId) as MemorySourceRow[]

  const nextFtsRowid = () =>
    (
      db.prepare('SELECT COALESCE(MAX(fts_rowid), 0) + 1 AS next FROM memory_entries').get() as {
        next: number
      }
    ).next

  const getMessageSource = (workspaceId: string, run: DreamRunRow, sequence: number) => {
    if (run.input_seq_from === null || run.input_seq_to === null) return undefined
    return db
      .prepare(
        `SELECT sequence, text
         FROM messages
         WHERE workspace_id = ?
           AND sequence = ?
           AND sequence BETWEEN ? AND ?
           AND type IN (${DREAM_SOURCE_MESSAGE_TYPES})
         LIMIT 1`
      )
      .get(workspaceId, sequence, run.input_seq_from, run.input_seq_to) as
      | { sequence: number; text: string | null }
      | undefined
  }

  const rememberPrior = (
    prior: Map<string, { entry: MemoryEntryRow; sources: MemorySourceRow[] }>,
    run: DreamRunRow,
    workspaceId: string,
    memoryId: string
  ) => {
    if (prior.has(memoryId)) return
    const row = requireMemoryRow(workspaceId, memoryId)
    requireRunMemoryUnchanged(run, row)
    prior.set(memoryId, { entry: row, sources: listSourceRows(memoryId) })
  }

  const validateTouchedIds = (operations: DreamOperation[]) => {
    const touched = new Set<string>()
    for (const op of operations) {
      const ids = op.op === 'add' ? [] : op.op === 'merge' ? [op.into, ...op.from] : [op.id]
      for (const id of ids) {
        if (touched.has(id)) {
          throw new DreamRunValidationError('Dream ops must not touch the same memory twice')
        }
        touched.add(id)
      }
    }
  }

  const insertDreamSource = (
    memoryId: string,
    sourceSequence: number | null,
    messageText: string | null,
    now: number
  ) => {
    const sourceType: MemorySourceType = sourceSequence === null ? 'dream' : 'message'
    db.prepare(
      `INSERT INTO memory_sources (
        id,
        memory_id,
        source_type,
        source_id,
        source_sequence,
        excerpt,
        text_hash,
        actor_agent_id_snapshot,
        actor_name_snapshot,
        actor_role_snapshot,
        created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`
    ).run(
      randomUUID(),
      memoryId,
      sourceType,
      sourceSequence,
      excerptFor(messageText),
      messageText ? hashText(messageText) : null,
      now
    )
  }

  const insertDreamMemory = (
    workspaceId: string,
    run: DreamRunRow,
    op: Extract<DreamOperation, { op: 'add' }>,
    now: number
  ): { body: string; id: string; kind: MemoryKind } => {
    const id = randomUUID()
    db.prepare(
      `INSERT INTO memory_entries (
        id,
        workspace_id,
        scope,
        fts_rowid,
        kind,
        body,
        tags,
        status,
        source,
        confidence,
        pinned,
        disabled,
        created_at,
        updated_at,
        archived_at,
        last_injected_at,
        ref_type,
        ref_id,
        ref_title
      ) VALUES (?, ?, 'workspace', ?, ?, ?, ?, 'active', 'dream', ?, 0, 0, ?, ?, NULL, NULL, ?, ?, ?)`
    ).run(
      id,
      workspaceId,
      nextFtsRowid(),
      op.kind,
      op.body,
      JSON.stringify(op.tags),
      op.confidence,
      now,
      now,
      op.procedureRef?.type ?? null,
      op.procedureRef?.id ?? null,
      op.procedureRef?.title ?? null
    )

    if (op.sources.length === 0) {
      insertDreamSource(id, null, null, now)
    } else {
      for (const sequence of op.sources) {
        const source = getMessageSource(workspaceId, run, sequence)
        if (!source) throw new DreamRunValidationError('Dream op source is outside this run input')
        insertDreamSource(id, sequence, source.text, now)
      }
    }

    return { body: op.body, id, kind: op.kind }
  }

  const updateEntryBody = (
    workspaceId: string,
    memoryId: string,
    input: {
      body: string
      confidence?: number | null | undefined
      kind?: MemoryKind | undefined
      procedureRef?: MemoryProcedureRef | null | undefined
      tags?: string[] | undefined
    },
    now: number
  ) => {
    const current = requireMemoryRow(workspaceId, memoryId)
    const nextKind = input.kind ?? current.kind
    const nextProcedureRef =
      input.procedureRef === undefined
        ? {
            id: current.ref_id,
            title: current.ref_title,
            type: current.ref_type,
          }
        : input.procedureRef
    if (nextKind === 'procedure_ref' && (!nextProcedureRef?.id || !nextProcedureRef.type)) {
      throw new DreamRunValidationError('Dream op procedure_ref is required for procedure_ref kind')
    }
    db.prepare(
      `UPDATE memory_entries
       SET body = ?,
           tags = ?,
           kind = ?,
           confidence = ?,
           ref_type = ?,
           ref_id = ?,
           ref_title = ?,
           updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND scope = 'workspace'`
    ).run(
      input.body,
      JSON.stringify(input.tags ?? parseTags(current.tags)),
      nextKind,
      input.confidence === undefined ? current.confidence : input.confidence,
      nextProcedureRef?.type ?? null,
      nextProcedureRef?.id ?? null,
      nextProcedureRef?.title ?? null,
      now,
      memoryId,
      workspaceId
    )
    insertDreamSource(memoryId, null, null, now)
  }

  const archiveEntry = (workspaceId: string, memoryId: string, now: number) => {
    requireMemoryRow(workspaceId, memoryId)
    db.prepare(
      `UPDATE memory_entries
       SET status = 'archived',
           archived_at = COALESCE(archived_at, ?),
           updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND scope = 'workspace'`
    ).run(now, now, memoryId, workspaceId)
    insertDreamSource(memoryId, null, null, now)
  }

  const buildPriorState = (workspaceId: string, run: DreamRunRow, operations: DreamOperation[]) => {
    validateTouchedIds(operations)
    const prior = new Map<string, { entry: MemoryEntryRow; sources: MemorySourceRow[] }>()
    for (const op of operations) {
      if (op.op === 'add') {
        for (const sequence of op.sources) {
          if (!getMessageSource(workspaceId, run, sequence)) {
            throw new DreamRunValidationError('Dream op source is outside this run input')
          }
        }
        continue
      }
      if (op.op === 'merge' && op.from.includes(op.into)) {
        throw new DreamRunValidationError('Dream merge cannot merge a memory into itself')
      }
      const ids = op.op === 'merge' ? [op.into, ...op.from] : [op.id]
      for (const id of ids) rememberPrior(prior, run, workspaceId, id)
    }
    return prior
  }

  const applyOperations = (workspaceId: string, run: DreamRunRow, operations: DreamOperation[]) => {
    const prior = buildPriorState(workspaceId, run, operations)
    const report: DreamRunReport = { added: [], archived: [], merged: [], rewritten: [] }
    const addedEntryIds: string[] = []
    const now = Date.now()
    for (const op of operations) {
      if (op.op === 'add') {
        const added = insertDreamMemory(workspaceId, run, op, now)
        addedEntryIds.push(added.id)
        report.added.push(added)
      } else if (op.op === 'archive') {
        archiveEntry(workspaceId, op.id, now)
        report.archived.push({ id: op.id, reason: op.reason })
      } else if (op.op === 'rewrite') {
        updateEntryBody(workspaceId, op.id, op, now)
        report.rewritten.push({ id: op.id })
      } else {
        updateEntryBody(workspaceId, op.into, op, now)
        for (const id of op.from) archiveEntry(workspaceId, id, now)
        report.merged.push({ from: op.from, into: op.into })
      }
    }
    return {
      report,
      revertBlob: {
        added_entry_ids: addedEntryIds,
        prior_entries: [...prior.values()],
      },
    }
  }

  const applyAndCompleteRunTransaction = db.transaction(
    (workspaceId: string, runId: string, rawOps: unknown): DreamRunRecord => {
      requireWorkspace(workspaceId)
      const run = requireRunningRunRow(workspaceId, runId)
      const { report, revertBlob } = applyOperations(workspaceId, run, parseDreamOperations(rawOps))
      db.prepare(
        `UPDATE dream_runs
         SET status = 'completed',
             finished_at = ?,
             report = ?,
             revert_blob = ?,
             error = NULL
         WHERE id = ?
           AND workspace_id = ?
           AND status = 'running'`
      ).run(Date.now(), JSON.stringify(report), JSON.stringify(revertBlob), runId, workspaceId)
      const completedRow = db
        .prepare('SELECT * FROM dream_runs WHERE id = ? AND workspace_id = ? LIMIT 1')
        .get(runId, workspaceId) as DreamRunRow | undefined
      if (!completedRow) throw new DreamRunValidationError('Dream run disappeared')
      return toDreamRunRecord(completedRow)
    }
  )
  const applyAndCompleteRun = (workspaceId: string, runId: string, rawOps: unknown) => {
    requireWorkspace(workspaceId)
    markStaleRunningRuns(workspaceId)
    return applyAndCompleteRunTransaction(workspaceId, runId, rawOps)
  }

  return { applyAndCompleteRun }
}
