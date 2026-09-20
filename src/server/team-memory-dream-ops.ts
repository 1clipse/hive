import {
  DREAM_MEMORY_BODY_MAX_CHARS,
  DREAM_MEMORY_MAX_ADDS_PER_RUN,
  isMemoryKind,
  isMemoryProcedureRefType,
  MEMORY_PROCEDURE_REF_ID_MAX_CHARS,
  MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TAG_MAX_COUNT,
  type MemoryKind,
  type MemoryProcedureRef,
} from '../shared/team-memory.js'

interface DreamOperationBase {
  op: string
}

export interface DreamAddOperation extends DreamOperationBase {
  body: string
  confidence: number
  kind: MemoryKind
  op: 'add'
  procedureRef: MemoryProcedureRef | null
  sources: number[]
  tags: string[]
}

export interface DreamRewriteOperation extends DreamOperationBase {
  body: string
  confidence?: number | null | undefined
  id: string
  kind?: MemoryKind | undefined
  op: 'rewrite'
  procedureRef?: MemoryProcedureRef | null | undefined
  tags?: string[] | undefined
}

export interface DreamArchiveOperation extends DreamOperationBase {
  id: string
  op: 'archive'
  reason: string | null
}

export interface DreamMergeOperation extends DreamOperationBase {
  body: string
  confidence?: number | null | undefined
  from: string[]
  into: string
  kind?: MemoryKind | undefined
  op: 'merge'
  procedureRef?: MemoryProcedureRef | null | undefined
  tags?: string[] | undefined
}

export type DreamOperation =
  | DreamAddOperation
  | DreamArchiveOperation
  | DreamMergeOperation
  | DreamRewriteOperation

export class DreamRunValidationError extends Error {
  readonly code = 'dream_validation_failed'
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DreamRunValidationError('Dream op must be an object')
  }
  return value as Record<string, unknown>
}

const requiredString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new DreamRunValidationError(`Dream op field ${field} must be a non-empty string`)
  }
  return value.trim()
}

const optionalString = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new DreamRunValidationError(`Dream op field ${field} must be a string`)
  }
  return value.trim() || null
}

const requiredBody = (record: Record<string, unknown>): string => {
  const body = requiredString(record, 'body')
  if ([...body].length > DREAM_MEMORY_BODY_MAX_CHARS) {
    throw new DreamRunValidationError(
      `Dream op body must be ${DREAM_MEMORY_BODY_MAX_CHARS} characters or fewer`
    )
  }
  return body
}

const requiredKind = (record: Record<string, unknown>): MemoryKind => {
  const kind = record.kind
  if (!isMemoryKind(kind)) throw new DreamRunValidationError('Dream op kind is invalid')
  return kind
}

const optionalKind = (record: Record<string, unknown>): MemoryKind | undefined => {
  const kind = record.kind
  if (kind === undefined || kind === null) return undefined
  if (!isMemoryKind(kind)) throw new DreamRunValidationError('Dream op kind is invalid')
  return kind
}

const optionalConfidence = (record: Record<string, unknown>): number | null | undefined => {
  const value = record.confidence
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DreamRunValidationError('Dream op confidence must be between 0 and 1')
  }
  return value
}

const optionalTags = (record: Record<string, unknown>): string[] | undefined => {
  const value = record.tags
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new DreamRunValidationError('Dream op tags must be an array')
  if (value.length > MEMORY_TAG_MAX_COUNT) {
    throw new DreamRunValidationError(`Dream op tags can include at most ${MEMORY_TAG_MAX_COUNT}`)
  }
  return value.map((tag) => {
    if (typeof tag !== 'string' || !tag.trim()) {
      throw new DreamRunValidationError('Dream op tags must be non-empty strings')
    }
    const trimmed = tag.trim()
    if ([...trimmed].length > MEMORY_TAG_MAX_CHARS) {
      throw new DreamRunValidationError(
        `Dream op tags must be ${MEMORY_TAG_MAX_CHARS} characters or fewer`
      )
    }
    return trimmed
  })
}

const optionalProcedureRef = (
  record: Record<string, unknown>
): MemoryProcedureRef | null | undefined => {
  const value = record.procedure_ref
  if (value === undefined) return undefined
  if (value === null) return null
  const refRecord = asRecord(value)
  if (!isMemoryProcedureRefType(refRecord.type)) {
    throw new DreamRunValidationError('Dream op procedure_ref.type is invalid')
  }
  const id = requiredString(refRecord, 'id')
  if ([...id].length > MEMORY_PROCEDURE_REF_ID_MAX_CHARS) {
    throw new DreamRunValidationError(
      `Dream op procedure_ref.id must be ${MEMORY_PROCEDURE_REF_ID_MAX_CHARS} characters or fewer`
    )
  }
  const title = optionalString(refRecord, 'title')
  if (title !== null && [...title].length > MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS) {
    throw new DreamRunValidationError(
      `Dream op procedure_ref.title must be ${MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS} characters or fewer`
    )
  }
  return { id, title, type: refRecord.type }
}

const optionalSourceSequences = (record: Record<string, unknown>): number[] => {
  const value = record.sources
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DreamRunValidationError('Dream op sources must be an array')
  return value.map((source) => {
    const sourceRecord = asRecord(source)
    const sequence = sourceRecord.sequence
    if (!Number.isInteger(sequence) || (sequence as number) <= 0) {
      throw new DreamRunValidationError('Dream op source sequence must be a positive integer')
    }
    return sequence as number
  })
}

export const parseDreamOperations = (rawOps: unknown): DreamOperation[] => {
  if (!Array.isArray(rawOps)) throw new DreamRunValidationError('Dream output ops must be an array')
  const operations = rawOps.map((rawOp) => {
    const record = asRecord(rawOp)
    switch (record.op) {
      case 'add': {
        const kind = requiredKind(record)
        const procedureRef = optionalProcedureRef(record) ?? null
        if (kind === 'procedure_ref' && procedureRef === null) {
          throw new DreamRunValidationError(
            'Dream op procedure_ref is required when kind is procedure_ref'
          )
        }
        return {
          body: requiredBody(record),
          confidence: optionalConfidence(record) ?? 0.5,
          kind,
          op: 'add',
          procedureRef,
          sources: optionalSourceSequences(record),
          tags: optionalTags(record) ?? [],
        } satisfies DreamAddOperation
      }
      case 'archive':
        return {
          id: requiredString(record, 'id'),
          op: 'archive',
          reason: optionalString(record, 'reason'),
        } satisfies DreamArchiveOperation
      case 'merge': {
        const from = record.from
        if (!Array.isArray(from) || from.length === 0) {
          throw new DreamRunValidationError('Dream merge op must include from ids')
        }
        return {
          body: requiredBody(record),
          confidence: optionalConfidence(record),
          from: from.map((id) => {
            if (typeof id !== 'string' || !id.trim()) {
              throw new DreamRunValidationError('Dream merge from ids must be non-empty strings')
            }
            return id.trim()
          }),
          into: requiredString(record, 'into'),
          kind: optionalKind(record),
          op: 'merge',
          procedureRef: optionalProcedureRef(record),
          tags: optionalTags(record),
        } satisfies DreamMergeOperation
      }
      case 'rewrite':
        return {
          body: requiredBody(record),
          confidence: optionalConfidence(record),
          id: requiredString(record, 'id'),
          kind: optionalKind(record),
          op: 'rewrite',
          procedureRef: optionalProcedureRef(record),
          tags: optionalTags(record),
        } satisfies DreamRewriteOperation
      default:
        throw new DreamRunValidationError('Unsupported dream op')
    }
  })
  const addCount = operations.filter((op) => op.op === 'add').length
  if (addCount > DREAM_MEMORY_MAX_ADDS_PER_RUN) {
    throw new DreamRunValidationError(
      `Dream run can add at most ${DREAM_MEMORY_MAX_ADDS_PER_RUN} memories`
    )
  }
  return operations
}
