import { describe, expect, test } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'
import { getWorkflowAgentId } from '../../src/server/workspace-store-support.js'

const makeStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createWorkspaceStore(db, []) }
}

describe('__workflow__ pseudo-agent', () => {
  test('every workspace exposes a workflow pseudo-agent resolvable by getAgent', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/wf', 'WF')
    const agent = store.getAgent(ws.id, getWorkflowAgentId(ws.id))
    expect(agent.role).toBe('workflow')
    expect(agent.name.length).toBeGreaterThan(0)
    db.close()
  })

  test('the workflow pseudo-agent is hidden from the worker roster', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/wf2', 'WF2')
    expect(store.listWorkers(ws.id).some((w) => w.id === getWorkflowAgentId(ws.id))).toBe(false)
    db.close()
  })

  test('the pseudo-agent survives a fresh hydration over the same db', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/wf3', 'WF3')
    const store2 = createWorkspaceStore(db, [])
    expect(store2.getAgent(ws.id, getWorkflowAgentId(ws.id)).role).toBe('workflow')
    db.close()
  })
})
