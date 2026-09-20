import { classifyCompletedRunStatus } from './agent-exit-classification.js'
import type { AgentRunSnapshot } from './agent-manager.js'
import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'

type PersistedRunStatus = PersistedAgentRun['status']

interface AgentRunSyncStore {
  updatePersistedRun: (
    runId: string,
    status: PersistedRunStatus,
    exitCode: number | null,
    endedAt: number | null
  ) => void
}

const MAX_RUN_OUTPUT_LENGTH = 1_000_000

type RunStatusInput = Pick<AgentRunSnapshot, 'status'> & {
  exitCode: number | null
  userStopped?: boolean
}

const toPersistedStatus = (run: RunStatusInput) => {
  if (
    'userStopped' in run &&
    run.userStopped === true &&
    (run.status === 'error' || run.status === 'exited')
  ) {
    return 'exited'
  }
  if (run.status === 'error' || run.status === 'exited' || run.status === 'starting') {
    return run.status
  }
  return run.exitCode === null ? 'running' : classifyCompletedRunStatus(run.exitCode)
}

export const syncPersistedRun = (
  run: LiveAgentRun,
  snapshot: AgentRunSnapshot,
  store: AgentRunSyncStore
) => {
  const nextStatus = toPersistedStatus(
    run.userStopped ? { ...snapshot, userStopped: true } : snapshot
  )
  const output = snapshot.output.slice(-MAX_RUN_OUTPUT_LENGTH)
  if (run.status === nextStatus && run.exitCode === snapshot.exitCode && run.output === output) {
    return run
  }

  const endedAt = nextStatus === 'exited' || nextStatus === 'error' ? Date.now() : null
  store.updatePersistedRun(run.runId, nextStatus, snapshot.exitCode, endedAt)
  run.status = nextStatus
  run.output = output
  run.exitCode = snapshot.exitCode
  return run
}

export const completeLiveRun = (
  run: LiveAgentRun,
  exitCode: number | null,
  endedAt: number,
  store: AgentRunSyncStore
) => {
  const nextStatus = run.userStopped ? 'exited' : classifyCompletedRunStatus(exitCode)
  store.updatePersistedRun(run.runId, nextStatus, exitCode, endedAt)
  run.status = nextStatus
  run.exitCode = exitCode
}
