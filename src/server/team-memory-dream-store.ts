import type { Database } from './sqlite.js'

import { createDreamOperationApplier } from './team-memory-dream-applier.js'
import { createDreamRunReverter } from './team-memory-dream-reverter.js'
import { createDreamRunStore } from './team-memory-dream-run-store.js'

export { DreamRunValidationError } from './team-memory-dream-ops.js'
export {
  DreamRunNotFoundError,
  DreamRunRevertDataError,
  DreamRunRevertStatusError,
} from './team-memory-dream-reverter.js'
export {
  DREAM_NO_ACTIVE_ORCHESTRATOR_ERROR_PREFIX,
  DREAM_RUNNING_STALE_MS,
  DREAM_STALE_ERROR,
  DreamRunAlreadyRunningError,
  DreamWorkspaceMissingError,
} from './team-memory-dream-run-store.js'
export type {
  DreamMessageInput,
  DreamRunRecord,
  DreamRunReport,
  DreamRunRevertBlob,
  DreamRunStatus,
  DreamRunTrigger,
  DreamScheduleState,
} from './team-memory-dream-types.js'

export const createTeamMemoryDreamStore = (db: Database) => {
  const runStore = createDreamRunStore(db)
  const applier = createDreamOperationApplier(db)
  const reverter = createDreamRunReverter(db)
  return {
    ...runStore,
    ...applier,
    ...reverter,
  }
}
