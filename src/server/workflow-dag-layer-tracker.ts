import type { WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'

interface WorkflowDagDispatchCancelPort {
  cancelOpenDispatchForRun: (workspaceId: string, dispatchId: string, reason: string) => boolean
}

const errorToMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createWorkflowDagLayerTracker = (input: {
  awaiter: Pick<WorkflowDispatchAwaiter, 'notifyCancel'>
  cancelQueuedAgentCallsForDagLayer: (layerId: string, reason: string) => void
  dispatchPort: WorkflowDagDispatchCancelPort
  workspaceId: string
}) => {
  const dagLayerDispatches = new Map<string, Set<string>>()

  const registerDispatch = (layerId: string | null, dispatchId: string) => {
    if (!layerId) return
    let dispatches = dagLayerDispatches.get(layerId)
    if (!dispatches) {
      dispatches = new Set()
      dagLayerDispatches.set(layerId, dispatches)
    }
    dispatches.add(dispatchId)
  }

  const cancelLayerAgents = (layerId: unknown, reason: unknown) => {
    const message =
      typeof reason === 'string' && reason.trim() ? reason : 'Workflow DAG node failed'

    const normalizedLayerId = typeof layerId === 'string' ? layerId.trim() : ''
    if (!normalizedLayerId) throw new Error('Missing DAG layer id')
    input.cancelQueuedAgentCallsForDagLayer(normalizedLayerId, message)

    const dispatchIds = dagLayerDispatches.get(normalizedLayerId) ?? new Set<string>()
    const errors: string[] = []
    for (const dispatchId of dispatchIds) {
      try {
        const cancelled = input.dispatchPort.cancelOpenDispatchForRun(
          input.workspaceId,
          dispatchId,
          message
        )
        if (cancelled) input.awaiter.notifyCancel(dispatchId, message)
      } catch (error) {
        errors.push(errorToMessage(error))
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '))
    }
  }

  return { cancelLayerAgents, registerDispatch }
}
