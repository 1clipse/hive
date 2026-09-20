import type { MemoryDigestPayload, WorkspaceMemoryDigestProvider } from './team-memory-digest.js'
import type { LogMemoryInjectionsInput } from './team-memory-store.js'

export interface TeamMemoryInjectionService {
  buildDigest: WorkspaceMemoryDigestProvider['buildDigest']
  buildDispatchDigest: WorkspaceMemoryDigestProvider['buildDispatchDigest']
  deleteInjections: (injectionIds: string[]) => void
  logInjections: (input: LogMemoryInjectionsInput) => string[]
}

export const buildMemoryDigestSafely = ({
  contextType,
  memoryInjection,
  workspaceId,
}: {
  contextType: 'recovery' | 'startup'
  memoryInjection: TeamMemoryInjectionService | undefined
  workspaceId: string
}) => {
  if (!memoryInjection) return null
  try {
    return memoryInjection.buildDigest({ contextType, workspaceId })
  } catch (error) {
    console.error('[hive] memory digest build failed', error)
    return null
  }
}

export const buildDispatchMemoryDigestSafely = ({
  memoryInjection,
  taskText,
  workerDescription,
  workspaceId,
}: {
  memoryInjection: TeamMemoryInjectionService | undefined
  taskText: string
  workerDescription: string
  workspaceId: string
}) => {
  if (!memoryInjection) return null
  try {
    return memoryInjection.buildDispatchDigest({ taskText, workerDescription, workspaceId })
  } catch (error) {
    console.error('[hive] dispatch memory digest build failed', error)
    return null
  }
}

export const logMemoryDigestInjection = ({
  agentId,
  contextType,
  dispatchId,
  memoryDigest,
  memoryInjection,
  workspaceId,
}: {
  agentId: string
  contextType: LogMemoryInjectionsInput['contextType']
  dispatchId?: string | null
  memoryDigest: MemoryDigestPayload | null | undefined
  memoryInjection: TeamMemoryInjectionService | undefined
  workspaceId: string
}) => {
  if (!memoryDigest || memoryDigest.memoryIds.length === 0 || !memoryInjection) return null
  try {
    return memoryInjection.logInjections({
      contextType,
      dispatchId: dispatchId ?? null,
      memoryIds: memoryDigest.memoryIds,
      targetAgentIdSnapshot: agentId,
      workspaceId,
    })
  } catch (error) {
    console.error('[hive] memory injection audit failed', error)
    return null
  }
}

export const rollbackMemoryDigestInjection = ({
  injectionIds,
  memoryInjection,
}: {
  injectionIds: string[] | null
  memoryInjection: TeamMemoryInjectionService | undefined
}) => {
  if (!injectionIds || injectionIds.length === 0 || !memoryInjection) return
  try {
    memoryInjection.deleteInjections(injectionIds)
  } catch (error) {
    console.error('[hive] memory injection audit rollback failed', error)
  }
}
