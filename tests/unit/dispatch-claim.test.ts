import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const makeLedger = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createDispatchLedgerStore(db)
}

describe('claimQueuedDispatch (delivery single-shot under races)', () => {
  test('exactly one of two racing claimers wins', () => {
    const ledger = makeLedger()
    const dispatch = ledger.createDispatch({
      text: 'implement login',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })
    expect(dispatch.status).toBe('queued')

    const first = ledger.claimQueuedDispatch(dispatch.id)
    const second = ledger.claimQueuedDispatch(dispatch.id)
    expect(first).toBe(true)
    expect(second).toBe(false)

    const after = ledger.findOpenDispatchById('ws-1', dispatch.id)
    expect(after?.status).toBe('submitted')
    expect(after?.submittedAt).not.toBeNull()
  })

  test('a reported or cancelled dispatch can never be re-claimed for delivery', () => {
    const ledger = makeLedger()
    const dispatch = ledger.createDispatch({
      text: 'implement login',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })
    ledger.markCancelled({ dispatchId: dispatch.id, reason: 'obsolete', workspaceId: 'ws-1' })
    expect(ledger.claimQueuedDispatch(dispatch.id)).toBe(false)
  })
})
