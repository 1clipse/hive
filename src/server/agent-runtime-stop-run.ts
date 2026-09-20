import type { AgentManager } from './agent-manager.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const stopLiveRun = (
  agentManager: AgentManager | undefined,
  registry: LiveRunRegistry,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  runId: string,
  onUserStop?: (runId: string) => void
) => {
  if (!agentManager) {
    throw new Error('Agent manager is required to stop agents')
  }

  const liveRun = registry.get(runId)
  if (liveRun) {
    const status = syncRun(liveRun).status
    if (status === 'exited' || status === 'error') {
      return
    }
  } else if (['error', 'exited'].includes(agentManager.getRun(runId).status)) {
    return
  }

  // Reaching here means the run was genuinely live and we are about to kill it
  // at the user's request — distinct from a crash that already ended the run.
  onUserStop?.(runId)
  agentManager.stopRun(runId)
}
