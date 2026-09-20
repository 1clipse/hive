import { describe, expect, test, vi } from 'vitest'

import { createWorkflowDagLayerTracker } from '../../src/server/workflow-dag-layer-tracker.js'

describe('createWorkflowDagLayerTracker', () => {
  test('cancels only dispatches registered to the failed DAG layer', () => {
    const notifyCancel = vi.fn()
    const cancelOpenDispatchForRun = vi.fn(() => true)
    const tracker = createWorkflowDagLayerTracker({
      awaiter: { notifyCancel },
      cancelQueuedAgentCallsForDagLayer: vi.fn(),
      dispatchPort: { cancelOpenDispatchForRun },
      workspaceId: 'workspace-1',
    })

    tracker.registerDispatch('layer-a', 'dispatch-a1')
    tracker.registerDispatch('layer-b', 'dispatch-b1')
    tracker.registerDispatch('layer-a', 'dispatch-a2')

    tracker.cancelLayerAgents('layer-a', 'DAG node failed: boom')

    expect(cancelOpenDispatchForRun).toHaveBeenCalledTimes(2)
    expect(cancelOpenDispatchForRun).toHaveBeenNthCalledWith(
      1,
      'workspace-1',
      'dispatch-a1',
      'DAG node failed: boom'
    )
    expect(cancelOpenDispatchForRun).toHaveBeenNthCalledWith(
      2,
      'workspace-1',
      'dispatch-a2',
      'DAG node failed: boom'
    )
    expect(notifyCancel).toHaveBeenCalledTimes(2)
    expect(notifyCancel).toHaveBeenNthCalledWith(1, 'dispatch-a1', 'DAG node failed: boom')
    expect(notifyCancel).toHaveBeenNthCalledWith(2, 'dispatch-a2', 'DAG node failed: boom')
  })

  test('does not notify the awaiter when the dispatch was already closed', () => {
    const notifyCancel = vi.fn()
    const tracker = createWorkflowDagLayerTracker({
      awaiter: { notifyCancel },
      cancelQueuedAgentCallsForDagLayer: vi.fn(),
      dispatchPort: { cancelOpenDispatchForRun: vi.fn(() => false) },
      workspaceId: 'workspace-1',
    })

    tracker.registerDispatch('layer-a', 'dispatch-a1')
    tracker.cancelLayerAgents('layer-a', 'closed elsewhere')

    expect(notifyCancel).not.toHaveBeenCalled()
  })

  test('does not notify awaiters before persistence succeeds when cancellation fails', () => {
    const notifyCancel = vi.fn()
    const tracker = createWorkflowDagLayerTracker({
      awaiter: { notifyCancel },
      cancelQueuedAgentCallsForDagLayer: vi.fn(),
      dispatchPort: {
        cancelOpenDispatchForRun: vi.fn(() => {
          throw new Error('readonly database')
        }),
      },
      workspaceId: 'workspace-1',
    })

    tracker.registerDispatch('layer-a', 'dispatch-a1')

    expect(() => tracker.cancelLayerAgents('layer-a', 'DAG node failed')).toThrow()
    expect(notifyCancel).not.toHaveBeenCalled()
  })

  test('rejects same-layer queued agent calls before cancelling registered dispatches', () => {
    const notifyCancel = vi.fn()
    const cancelQueuedAgentCallsForDagLayer = vi.fn()
    const cancelOpenDispatchForRun = vi.fn(() => true)
    const tracker = createWorkflowDagLayerTracker({
      awaiter: { notifyCancel },
      cancelQueuedAgentCallsForDagLayer,
      dispatchPort: { cancelOpenDispatchForRun },
      workspaceId: 'workspace-1',
    })

    tracker.registerDispatch('layer-a', 'dispatch-a1')
    tracker.cancelLayerAgents('layer-a', 'DAG node failed')

    expect(cancelQueuedAgentCallsForDagLayer).toHaveBeenCalledWith('layer-a', 'DAG node failed')
    expect(cancelOpenDispatchForRun).toHaveBeenCalledWith(
      'workspace-1',
      'dispatch-a1',
      'DAG node failed'
    )
    expect(notifyCancel).toHaveBeenCalledWith('dispatch-a1', 'DAG node failed')
  })
})
