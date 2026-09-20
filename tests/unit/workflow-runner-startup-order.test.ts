import { describe, expect, test, vi } from 'vitest'

import { DEFAULT_WORKFLOW_CLI_POLICY } from '../../src/server/workflow-cli-policy.js'
import type { WorkflowRunRecord, WorkflowRunStatus } from '../../src/server/workflow-run-store.js'
import { createWorkflowRunner } from '../../src/server/workflow-runner.js'

const waitFor = async (assertion: () => void | Promise<void>, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

const createInMemoryWorkflowRunStore = () => {
  const runs = new Map<string, WorkflowRunRecord>()
  return {
    createRun(input: {
      args?: unknown
      name: string
      parentRunId?: string | null
      scriptHash?: string
      scriptPath: string
      workspaceId: string
    }) {
      const now = Date.now()
      const record: WorkflowRunRecord = {
        agentCount: 0,
        args: input.args ?? null,
        createdAt: now,
        error: null,
        finishedAt: null,
        id: 'run-1',
        name: input.name,
        parentRunId: input.parentRunId ?? null,
        phase: null,
        result: null,
        scriptHash: input.scriptHash ?? null,
        scriptPath: input.scriptPath,
        startedAt: now,
        status: 'running',
        workspaceId: input.workspaceId,
      }
      runs.set(record.id, record)
      return record
    },
    getRun(id: string) {
      return runs.get(id)
    },
    listChildRuns(parentRunId: string) {
      return [...runs.values()].filter((run) => run.parentRunId === parentRunId)
    },
    updateRun(
      id: string,
      input: { error?: string; finishedAt?: number; result?: unknown; status?: WorkflowRunStatus }
    ) {
      const current = runs.get(id)
      if (!current) return
      runs.set(id, { ...current, ...input })
    },
  }
}

describe('workflow runner startup ordering', () => {
  test('waits for workflow worker startup input before dispatching the agent task', async () => {
    let markStartupReady!: () => void
    const postStartInputReady = new Promise<void>((resolve) => {
      markStartupReady = resolve
    })
    const startAgent = vi.fn(async () => ({ postStartInputReady }))
    const dispatchTaskByWorkerName = vi.fn(async () => ({ id: 'dispatch-1' }))
    const workflowRunStore = createInMemoryWorkflowRunStore()
    const runner = createWorkflowRunner({
      awaiter: {
        awaitReport: vi.fn(async () => ({ artifacts: [], text: 'done' })),
        cancelAll: vi.fn(),
        forceCancel: vi.fn(),
        notifyCancel: vi.fn(),
        notifyReport: vi.fn(),
      },
      dispatchPort: {
        cancelOpenDispatchForRun: vi.fn(() => false),
        listOpenDispatchIdsForRun: vi.fn(() => []),
      },
      getWorkflowCliPolicy: () => DEFAULT_WORKFLOW_CLI_POLICY,
      logStore: { append: vi.fn() },
      resolveCliLaunchConfig: () => undefined,
      resolveWorkspacePath: () => '/tmp/hive-workflow-order',
      roleTemplateResolver: { findByName: vi.fn(() => undefined) },
      store: {
        addWorkerWithLaunch: vi.fn(() => ({ id: 'worker-1', name: 'review-1' })),
        deleteWorker: vi.fn(),
        dispatchTaskByWorkerName,
        startAgent,
      },
      workflowRunStore,
    })

    await runner.startWorkflowInline({
      hivePort: '4010',
      source: [
        "export const meta = { name: 'startup-order', description: 'd' }",
        "return await agent('review this', { agentType: 'reviewer', label: 'review-1' })",
      ].join('\n'),
      workspaceId: 'ws-1',
    })

    await waitFor(() => expect(startAgent).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(dispatchTaskByWorkerName).not.toHaveBeenCalled()

    markStartupReady()

    await waitFor(() => expect(dispatchTaskByWorkerName).toHaveBeenCalledTimes(1))
    expect(dispatchTaskByWorkerName).toHaveBeenCalledWith(
      'ws-1',
      'review-1',
      'review this',
      expect.objectContaining({ workflowRunId: 'run-1' })
    )
  })
})
