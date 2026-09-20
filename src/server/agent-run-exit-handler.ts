import type { AgentRunExitContext } from './agent-run-start-context.js'
import { completeLiveRun } from './agent-run-sync.js'
import { clearResumedSessionAfterExitIfStale } from './resumed-session-cleanup.js'

interface HandleRunExitInput {
  exitCode: number | null
  endedAt: number
  runId: string
}

export const handleAgentRunExit = (
  context: AgentRunExitContext,
  { exitCode, endedAt, runId }: HandleRunExitInput
) => {
  context.registry.setPendingExitCode(runId, exitCode)
  const liveRun = context.registry.get(runId)
  if (!liveRun) {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    return false
  }
  if (context.handledRunExits.has(runId)) {
    context.registry.clearPendingExitCode(runId)
    return false
  }

  context.handledRunExits.add(runId)
  try {
    completeLiveRun(liveRun, exitCode, endedAt, context.store)
    if (!liveRun.userStopped) clearResumedSessionAfterExitIfStale({ ...context, exitCode })
    context.onAgentExit(context.workspace.id, context.agentId)
    return true
  } finally {
    context.tokenRegistry.revokeIfMatches(context.agentId, context.token)
    context.registry.resolveExit(runId)
    context.registry.clearPendingExitCode(runId)
  }
}
