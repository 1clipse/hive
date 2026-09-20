import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { createDispatchMessageStore } from '../../src/server/dispatch-message-store.js'
import { ConflictError } from '../../src/server/http-errors.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations } from '../../src/server/team-operations.js'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const boot = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  const ledger = createDispatchLedgerStore(db)
  const messages = createMessageLogStore(db)
  const dispatchMessages = createDispatchMessageStore(db)
  const reportOutbox = createReportOutboxStore(db)
  const workspaces = createWorkspaceStore(db, () => ledger.listOpenDispatchKinds())
  const ops = createTeamOperations({
    agentRuntime: {
      getActiveRunByAgentId: () => undefined,
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
    reportOutbox,
    workflowDispatchAwaiter: createWorkflowDispatchAwaiter(),
    workspaceStore: workspaces,
  })
  return { db, dispatchMessages, ledger, ops, workspaces }
}

describe('team report open-dispatch target (#79)', () => {
  test('report without --dispatch closes the live submitted row, not an older queued one', () => {
    const { db, ledger, ops, workspaces } = boot()
    try {
      const workspace = workspaces.createWorkspace('/tmp/hive-report-target', 'Target')
      const worker = workspaces.addWorker(workspace.id, { name: 'Fay', role: 'coder' })
      const parked = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'older parked task',
      })
      const live = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'later submitted task the worker is doing',
      })
      expect(ledger.claimQueuedDispatch(live.id)).toBe(true)

      const report = ops.reportTask(workspace.id, worker.id, { text: 'done' })

      expect(report.dispatch?.id).toBe(live.id)
      expect(ledger.getDispatch(workspace.id, parked.id)?.status).toBe('queued')
      expect(ledger.getDispatch(workspace.id, live.id)?.status).toBe('reported')
    } finally {
      db.close()
    }
  })

  test('report without --dispatch is a conflict when two submitted rows are open', () => {
    const { db, ledger, ops, workspaces } = boot()
    try {
      const workspace = workspaces.createWorkspace('/tmp/hive-report-ambiguous', 'Ambiguous')
      const worker = workspaces.addWorker(workspace.id, { name: 'Fay', role: 'coder' })
      const first = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'first submitted',
      })
      const second = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'second submitted',
      })
      expect(ledger.claimQueuedDispatch(first.id)).toBe(true)
      expect(ledger.claimQueuedDispatch(second.id)).toBe(true)

      expect(() => ops.reportTask(workspace.id, worker.id, { text: 'done' })).toThrow(ConflictError)
      expect(ledger.getDispatch(workspace.id, first.id)?.status).toBe('submitted')
      expect(ledger.getDispatch(workspace.id, second.id)?.status).toBe('submitted')
    } finally {
      db.close()
    }
  })

  test('explicit --dispatch of a queued id is rejected while a submitted row is live', () => {
    const { db, ledger, ops, workspaces } = boot()
    try {
      const workspace = workspaces.createWorkspace('/tmp/hive-report-queued-id', 'QueuedId')
      const worker = workspaces.addWorker(workspace.id, { name: 'Fay', role: 'coder' })
      const parked = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'parked',
      })
      const live = ledger.createDispatch({
        workspaceId: workspace.id,
        toAgentId: worker.id,
        text: 'live',
      })
      expect(ledger.claimQueuedDispatch(live.id)).toBe(true)

      expect(() =>
        ops.reportTask(workspace.id, worker.id, { text: 'done', dispatchId: parked.id })
      ).toThrow(ConflictError)
      expect(ledger.getDispatch(workspace.id, parked.id)?.status).toBe('queued')
      expect(ledger.getDispatch(workspace.id, live.id)?.status).toBe('submitted')
    } finally {
      db.close()
    }
  })
})
