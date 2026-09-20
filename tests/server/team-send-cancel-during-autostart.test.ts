import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { ConflictError } from '../../src/server/http-errors.js'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createReportOutboxStore } from '../../src/server/report-outbox-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createTeamOperations } from '../../src/server/team-operations.js'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('team send vs cancel during auto-start (#78)', () => {
  test('dispatchTask rejects when the new row is cancelled while the worker starts', async () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const ledger = createDispatchLedgerStore(db)
    const messages = createMessageLogStore(db)
    const reportOutbox = createReportOutboxStore(db)
    const workspaces = createWorkspaceStore(db, () => ledger.listOpenDispatchKinds())
    const workspace = workspaces.createWorkspace('/tmp/hive-send-cancel-autostart', 'Auto')
    const worker = workspaces.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const orch = workspaces.getAgent(workspace.id, `${workspace.id}:orchestrator`)
    let releaseStart!: () => void
    const startHeld = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const ops = createTeamOperations({
      agentRuntime: {
        getActiveRunByAgentId: () => undefined,
        peekAgentLaunchConfig: () => ({ command: 'node' }),
        startAgent: async () => {
          await startHeld
          return { status: 'running', runId: 'run-1', postStartInputReady: undefined }
        },
        writeSendPrompt: () => Promise.resolve(),
        writeCancelPrompt: () => Promise.resolve(),
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
    })

    const sendPromise = ops.dispatchTask(workspace.id, worker.id, 'do the thing', {
      fromAgentId: orch.id,
      autoStartWorker: true,
    })
    let createdId: string | undefined
    for (let i = 0; i < 50; i++) {
      const open = ledger.listOpenWorkspaceDispatches(workspace.id)
      if (open[0]) {
        createdId = open[0].id
        break
      }
      await sleep(10)
    }
    if (!createdId) throw new Error('dispatch was never created')

    await ops.cancelTask(workspace.id, createdId, {
      fromAgentId: orch.id,
      reason: 'user cancelled',
    })
    releaseStart()
    await expect(sendPromise).rejects.toBeInstanceOf(ConflictError)
    expect(ledger.getDispatch(workspace.id, createdId)?.status).toBe('cancelled')
    expect(ledger.getDispatch(workspace.id, createdId)?.reportText).toBe('user cancelled')
    db.close()
  })
})
