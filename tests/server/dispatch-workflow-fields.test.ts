import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const makeLedger = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createDispatchLedgerStore(db)
}

describe('dispatch workflow fields', () => {
  test('persists workflowRunId + stepIndex and reads them back', () => {
    const ledger = makeLedger()
    const created = ledger.createDispatch({
      workspaceId: 'ws',
      toAgentId: 'ws:w1',
      text: 'do step',
      fromAgentId: 'ws:__workflow__',
      workflowRunId: 'run-7',
      stepIndex: 2,
    })
    expect(created.workflowRunId).toBe('run-7')
    expect(created.stepIndex).toBe(2)
    const [listed] = ledger.listWorkspaceDispatches('ws')
    expect(listed?.workflowRunId).toBe('run-7')
    expect(listed?.stepIndex).toBe(2)
  })

  test('defaults workflow fields to null for a normal dispatch', () => {
    const ledger = makeLedger()
    const created = ledger.createDispatch({ workspaceId: 'ws', toAgentId: 'ws:w1', text: 'hi' })
    expect(created.workflowRunId).toBeNull()
    expect(created.stepIndex).toBeNull()
  })
})
