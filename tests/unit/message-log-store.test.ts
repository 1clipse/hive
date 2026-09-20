import { describe, expect, test } from 'vitest'
import { createMessageLogStore } from '../../src/server/message-log-store.js'
import { createUserInputMessage } from '../../src/server/runtime-message-builders.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('message log store', () => {
  test('detects user input by orchestrator worker id', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const store = createMessageLogStore(db)
    const workspaceId = 'workspace-1'
    const orchestratorId = `${workspaceId}:orchestrator`

    store.insertMessage({
      ...createUserInputMessage(workspaceId, orchestratorId, 'Use Hive to implement the issue'),
      createdAt: 1_000,
    })

    expect(store.hasUserInputSince(workspaceId, orchestratorId, 999)).toBe(true)
    expect(store.hasUserInputSince(workspaceId, orchestratorId, 1_001)).toBe(false)
    expect(store.hasUserInputSince(workspaceId, 'workspace-1:worker-a', 999)).toBe(false)

    db.close()
  })
})
