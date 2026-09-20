import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations } from '../../src/server/team-operations.js'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const boot = (input: {
  writeSendPrompt: () => Promise<void>
  isRuntimeClosing?: () => boolean
}) => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db)
  const messages = createMessageLogStore(db)
  const reportOutbox = createReportOutboxStore(db)
  const workspaces = createWorkspaceStore(db, () => ledger.listOpenDispatchKinds())
  const ops = createTeamOperations({
    agentRuntime: {
      getActiveRunByAgentId: () => ({ runId: 'run-1', status: 'running' }),
      writeSendPrompt: input.writeSendPrompt,
      deliverSystemMessageToAgent: () => Promise.resolve(),
    } as never,
    createDispatch: ledger.createDispatch,
    deleteDispatch: ledger.deleteDispatch,
    deleteMessage: messages.deleteMessage,
    findOpenDispatch: ledger.findOpenDispatch,
    findOpenDispatchById: ledger.findOpenDispatchById,
    listOpenWorkspaceDispatches: ledger.listOpenWorkspaceDispatches,
    insertMessage: messages.insertMessage,
    markDispatchCancelled: ledger.markCancelled,
    markDispatchReportedByWorker: ledger.markReportedByWorker,
    claimQueuedDispatch: ledger.claimQueuedDispatch,
    reparkClaimedDispatch: ledger.reparkClaimedDispatch,
    markDispatchDelivered: ledger.markDispatchDelivered,
    reportOutbox,
    workflowDispatchAwaiter: createWorkflowDispatchAwaiter(),
    workspaceStore: workspaces,
    ...(input.isRuntimeClosing ? { isRuntimeClosing: input.isRuntimeClosing } : {}),
  })
  return { db, ledger, ops, workspaces }
}

describe('replay of submitted dispatches after restart (#80)', () => {
  test('startup replay re-delivers a submitted row whose PTY write never completed', async () => {
    const writes: string[] = []
    const { db, ledger, ops, workspaces } = boot({
      writeSendPrompt: async () => {
        writes.push('delivered')
      },
    })
    try {
      const workspace = workspaces.createWorkspace('/tmp/hive-replay-submitted', 'Replay')
      const worker = workspaces.addWorker(workspace.id, { name: 'Cara', role: 'coder' })
      const orch = workspaces.getAgent(workspace.id, `${workspace.id}:orchestrator`)
      const createdAt = Date.now() - 5_000
      const dispatch = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        fromAgentId: orch.id,
        text: 'in-flight at crash',
      })
      expect(ledger.claimQueuedDispatch(dispatch.id)).toBe(true)
      expect(ledger.getDispatch(workspace.id, dispatch.id)?.status).toBe('submitted')
      expect(ledger.getDispatch(workspace.id, dispatch.id)?.deliveredAt).toBeNull()

      ops.replayQueuedDispatches(workspace.id, worker.id, { createdBeforeMs: createdAt + 10_000 })
      await sleep(20)

      const after = ledger.getDispatch(workspace.id, dispatch.id)
      expect(writes).toEqual(['delivered'])
      expect(after?.status).toBe('submitted')
      expect(after?.deliveredAt).toEqual(expect.any(Number))
    } finally {
      db.close()
    }
  })

  test('startup replay does not re-paste a submitted row whose write already completed', async () => {
    const writes: string[] = []
    const { db, ledger, ops, workspaces } = boot({
      writeSendPrompt: async () => {
        writes.push('delivered')
      },
    })
    try {
      const workspace = workspaces.createWorkspace('/tmp/hive-replay-delivered', 'Delivered')
      const worker = workspaces.addWorker(workspace.id, { name: 'Cara', role: 'coder' })
      const orch = workspaces.getAgent(workspace.id, `${workspace.id}:orchestrator`)
      const dispatch = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        fromAgentId: orch.id,
        text: 'already pasted',
      })
      expect(ledger.claimQueuedDispatch(dispatch.id)).toBe(true)
      expect(ledger.markDispatchDelivered(dispatch.id)).toBe(true)

      ops.replayQueuedDispatches(workspace.id, worker.id, { createdBeforeMs: Date.now() + 1_000 })
      await sleep(20)

      expect(writes).toEqual([])
      expect(ledger.getDispatch(workspace.id, dispatch.id)?.status).toBe('submitted')
    } finally {
      db.close()
    }
  })
})
