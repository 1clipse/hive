import { buildMemoryDreamInput, type MemoryDreamInput } from './team-memory-dream-input.js'
import {
  DREAM_STALE_ERROR,
  type DreamMessageInput,
  DreamRunNotFoundError,
  type DreamRunRecord,
  DreamRunValidationError,
} from './team-memory-dream-store.js'
import type { MemoryEntryWithSources } from './team-memory-store.js'

export type { MemoryDreamInput } from './team-memory-dream-input.js'

interface RuntimeStoreDreamServices {
  teamMemoryDreamRunner: {
    runManual: (workspaceId: string) => Promise<DreamRunRecord>
  }
  teamMemoryDreamScheduler: {
    tick: (now?: number) => Promise<void>
  }
  teamMemoryDreamStore: {
    applyAndCompleteRun: (workspaceId: string, runId: string, rawOps: unknown) => DreamRunRecord
    getRun: (runId: string) => DreamRunRecord | undefined
    listInputMessages: (
      workspaceId: string,
      from: number | null,
      to: number | null
    ) => DreamMessageInput[]
    listRuns: (workspaceId: string, limit?: number) => DreamRunRecord[]
    revertRun: (workspaceId: string, runId: string) => DreamRunRecord
  }
  teamMemoryStore: {
    listAllEntries: (workspaceId: string) => MemoryEntryWithSources[]
  }
  teamMemoryExport: {
    schedule: (workspaceId: string) => void
  }
}

const shouldExportStaleRun = (run: DreamRunRecord) =>
  run.status === 'failed' && run.error === DREAM_STALE_ERROR

export const createRuntimeStoreDreamMethods = (services: RuntimeStoreDreamServices) => ({
  applyMemoryDreamRun(workspaceId: string, runId: string, rawOps: unknown) {
    const existing = services.teamMemoryDreamStore.getRun(runId)
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new DreamRunNotFoundError(workspaceId, runId)
    }
    if (existing.status !== 'running') {
      if (shouldExportStaleRun(existing)) services.teamMemoryExport.schedule(workspaceId)
      throw new DreamRunValidationError('Dream run is no longer running')
    }
    try {
      const run = services.teamMemoryDreamStore.applyAndCompleteRun(workspaceId, runId, rawOps)
      services.teamMemoryExport.schedule(workspaceId)
      return run
    } catch (error) {
      services.teamMemoryExport.schedule(workspaceId)
      throw error
    }
  },
  getMemoryDreamInput(workspaceId: string, runId: string): MemoryDreamInput {
    const run = services.teamMemoryDreamStore.getRun(runId)
    if (!run || run.workspaceId !== workspaceId) throw new DreamRunNotFoundError(workspaceId, runId)
    if (run.status !== 'running') {
      if (shouldExportStaleRun(run)) services.teamMemoryExport.schedule(workspaceId)
      throw new DreamRunValidationError('Dream run is no longer running')
    }
    return buildMemoryDreamInput(services, workspaceId, run)
  },
  listMemoryDreamRuns(workspaceId: string, limit?: number) {
    const runs = services.teamMemoryDreamStore.listRuns(workspaceId, limit)
    if (runs.some(shouldExportStaleRun)) {
      services.teamMemoryExport.schedule(workspaceId)
    }
    return runs
  },
  revertMemoryDream(workspaceId: string, runId: string) {
    const run = services.teamMemoryDreamStore.revertRun(workspaceId, runId)
    services.teamMemoryExport.schedule(workspaceId)
    return run
  },
  runMemoryDream(workspaceId: string) {
    return services.teamMemoryDreamRunner.runManual(workspaceId)
  },
  tickMemoryDreamScheduler(now?: number) {
    return services.teamMemoryDreamScheduler.tick(now)
  },
})
