export const MEMORY_BODY_MAX_CHARS = 4000
export const DREAM_MEMORY_BODY_MAX_CHARS = 500
export const DREAM_MEMORY_MAX_ADDS_PER_RUN = 10
export const MEMORY_QUERY_MAX_CHARS = 500
export const MEMORY_SEARCH_DEFAULT_LIMIT = 10
export const MEMORY_SEARCH_MAX_LIMIT = 50
export const MEMORY_TAG_MAX_CHARS = 64
export const MEMORY_TAG_MAX_COUNT = 20
export const MEMORY_PROCEDURE_REF_ID_MAX_CHARS = 256
export const MEMORY_PROCEDURE_REF_TITLE_MAX_CHARS = 160

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'pitfall', 'procedure_ref'] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const isMemoryKind = (value: unknown): value is MemoryKind =>
  typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)

export const MEMORY_SCOPES = ['workspace', 'user'] as const

export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const isMemoryScope = (value: unknown): value is MemoryScope =>
  typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)

export const MEMORY_PROCEDURE_REF_TYPES = [
  'workflow',
  'skill',
  'procedure',
  'template',
  'doc',
] as const

export type MemoryProcedureRefType = (typeof MEMORY_PROCEDURE_REF_TYPES)[number]

export interface MemoryProcedureRef {
  id: string
  title: string | null
  type: MemoryProcedureRefType
}

export const isMemoryProcedureRefType = (value: unknown): value is MemoryProcedureRefType =>
  typeof value === 'string' && (MEMORY_PROCEDURE_REF_TYPES as readonly string[]).includes(value)
