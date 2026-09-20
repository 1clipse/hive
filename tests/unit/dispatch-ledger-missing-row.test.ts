import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const dispatchCount = (db: Database) =>
  (db.prepare('SELECT COUNT(*) AS count FROM dispatches').get() as { count: number }).count

describe('dispatch ledger metrics writes against a missing row', () => {
  test('markDelivered and recordReportPayloadBytes do not insert a dispatch', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const ledger = createDispatchLedgerStore(db)

    expect(dispatchCount(db)).toBe(0)
    ledger.markDelivered({
      deliveredAt: 1,
      dispatchId: 'missing-dispatch',
      dispatchPayloadBytes: 16,
    })
    ledger.recordReportPayloadBytes('missing-dispatch', 8)
    expect(dispatchCount(db)).toBe(0)
    expect(ledger.getDispatch('ws-1', 'missing-dispatch')).toBeUndefined()

    const created = ledger.createDispatch({
      text: 'gone',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })
    expect(dispatchCount(db)).toBe(1)
    ledger.deleteDispatch(created.id)
    expect(dispatchCount(db)).toBe(0)

    ledger.markDelivered({
      deliveredAt: 2,
      dispatchId: created.id,
      dispatchPayloadBytes: 32,
    })
    ledger.recordReportPayloadBytes(created.id, 4)
    expect(dispatchCount(db)).toBe(0)
    expect(ledger.getDispatch('ws-1', created.id)).toBeUndefined()

    db.close()
  })
})
