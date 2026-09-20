import { buildDreamMaintenancePayload } from './team-memory-dream-prompt.js'
import {
  DreamRunAlreadyRunningError,
  type DreamRunRecord,
  type DreamRunTrigger,
} from './team-memory-dream-store.js'

interface DreamStorePort {
  createRun: (input: { trigger: DreamRunTrigger; workspaceId: string }) => DreamRunRecord
  getRunningScheduledRun: (workspaceId: string) => DreamRunRecord | undefined
  markFailed: (
    runId: string,
    error: string,
    fallback?: DreamRunRecord | undefined
  ) => DreamRunRecord
}

export interface TeamMemoryDreamRunner {
  runManual: (workspaceId: string) => Promise<DreamRunRecord>
  runScheduled: (workspaceId: string) => Promise<DreamRunRecord>
}

const truncateError = (value: string) => [...value].slice(0, 1000).join('')

export const createTeamMemoryDreamRunner = (deps: {
  applyScheduledRun: (workspaceId: string, runId: string, rawOps: unknown) => DreamRunRecord
  buildScheduledInput: (workspaceId: string, run: DreamRunRecord) => { prompt: string }
  dreamStore: DreamStorePort
  deliverToOrchestrator: (workspaceId: string, text: string) => Promise<void>
  executeScheduledDream: (input: { prompt: string; workspaceId: string }) => Promise<unknown>
  scheduleExport: (workspaceId: string) => void
}): TeamMemoryDreamRunner => {
  const runningWorkspaceIds = new Set<string>()

  const createOrReuseRun = (workspaceId: string, trigger: DreamRunTrigger) =>
    trigger === 'scheduled'
      ? (deps.dreamStore.getRunningScheduledRun(workspaceId) ??
        deps.dreamStore.createRun({ trigger, workspaceId }))
      : deps.dreamStore.createRun({ trigger, workspaceId })

  const runManual = async (workspaceId: string): Promise<DreamRunRecord> => {
    if (runningWorkspaceIds.has(workspaceId)) throw new DreamRunAlreadyRunningError(workspaceId)
    runningWorkspaceIds.add(workspaceId)
    let runRecord: DreamRunRecord | undefined
    try {
      runRecord = createOrReuseRun(workspaceId, 'manual')
      await deps.deliverToOrchestrator(workspaceId, buildDreamMaintenancePayload(runRecord))
      deps.scheduleExport(workspaceId)
      return runRecord
    } catch (error) {
      if (!runRecord) throw error
      const message = error instanceof Error ? error.message : String(error)
      const failed = deps.dreamStore.markFailed(runRecord.id, truncateError(message), runRecord)
      deps.scheduleExport(workspaceId)
      return failed
    } finally {
      runningWorkspaceIds.delete(workspaceId)
    }
  }

  const runScheduled = async (workspaceId: string): Promise<DreamRunRecord> => {
    if (runningWorkspaceIds.has(workspaceId)) throw new DreamRunAlreadyRunningError(workspaceId)
    runningWorkspaceIds.add(workspaceId)
    let runRecord: DreamRunRecord | undefined
    try {
      runRecord = createOrReuseRun(workspaceId, 'scheduled')
      const input = deps.buildScheduledInput(workspaceId, runRecord)
      const raw = await deps.executeScheduledDream({ prompt: input.prompt, workspaceId })
      const completed = deps.applyScheduledRun(workspaceId, runRecord.id, raw)
      deps.scheduleExport(workspaceId)
      return completed
    } catch (error) {
      if (!runRecord) throw error
      const message = error instanceof Error ? error.message : String(error)
      const failed = deps.dreamStore.markFailed(runRecord.id, truncateError(message), runRecord)
      deps.scheduleExport(workspaceId)
      return failed
    } finally {
      runningWorkspaceIds.delete(workspaceId)
    }
  }

  return {
    runManual,
    runScheduled,
  }
}
