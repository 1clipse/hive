import { describe, expect, test } from 'vitest'
import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkflowRunStore } from '../../src/server/workflow-run-store.js'

const make = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createWorkflowRunStore(db)
}

const makeWithLedger = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createWorkflowRunStore(db), ledger: createDispatchLedgerStore(db) }
}

describe('workflow-run-store', () => {
  test('creates a running run and reads it back', () => {
    const store = make()
    const run = store.createRun({
      workspaceId: 'ws',
      scriptPath: '.hive/workflows/review.ts',
      scriptHash: 'abc',
      name: 'review-changes',
      args: { q: 1 },
    })
    expect(run.status).toBe('running')
    expect(run.name).toBe('review-changes')
    const fetched = store.getRun(run.id)
    expect(fetched?.scriptHash).toBe('abc')
    expect(fetched?.args).toEqual({ q: 1 })
  })

  test('updates phase, status, finishedAt, error', () => {
    const store = make()
    const run = store.createRun({ workspaceId: 'ws', scriptPath: 'p', name: 'n' })
    store.updateRun(run.id, { phase: 'Verify' })
    store.updateRun(run.id, { status: 'failed', finishedAt: 123, error: 'boom' })
    const fetched = store.getRun(run.id)
    expect(fetched?.phase).toBe('Verify')
    expect(fetched?.status).toBe('failed')
    expect(fetched?.finishedAt).toBe(123)
    expect(fetched?.error).toBe('boom')
  })

  test('lists workspace runs newest-first and marks unfinished runs interrupted', () => {
    const store = make()
    const a = store.createRun({ workspaceId: 'ws', scriptPath: 'p', name: 'a' })
    store.updateRun(a.id, { status: 'completed', finishedAt: 1 })
    store.createRun({ workspaceId: 'ws', scriptPath: 'p', name: 'b' })
    store.markUnfinishedRunsInterrupted()
    const runs = store.listWorkspaceRuns('ws')
    expect(runs.map((r) => r.name)).toContain('b')
    expect(runs.find((r) => r.name === 'b')?.status).toBe('interrupted')
    expect(runs.find((r) => r.name === 'a')?.status).toBe('completed')
  })

  test('agentCount reflects the count of dispatches tagged with workflow_run_id (TIER 1 #14)', () => {
    /* Without an agentCount on the run row, the Drawer can't show "12
       agents" on a row without an extra round-trip per expand. We add
       it as a subquery against dispatches.workflow_run_id (already
       indexed), so listWorkspaceRuns stays one round-trip. */
    const { ledger, store } = makeWithLedger()
    const run = store.createRun({ workspaceId: 'ws', scriptPath: 'p', name: 'parallel' })
    expect(store.getRun(run.id)?.agentCount).toBe(0)
    ledger.createDispatch({
      workspaceId: 'ws',
      fromAgentId: 'ws:__workflow__',
      toAgentId: 'ws:worker-1',
      text: 'audit a',
      workflowRunId: run.id,
      stepIndex: 1,
    })
    ledger.createDispatch({
      workspaceId: 'ws',
      fromAgentId: 'ws:__workflow__',
      toAgentId: 'ws:worker-2',
      text: 'audit b',
      workflowRunId: run.id,
      stepIndex: 2,
    })
    // Plant a dispatch NOT tagged with this run — must not be counted.
    ledger.createDispatch({
      workspaceId: 'ws',
      fromAgentId: 'ws:orchestrator',
      toAgentId: 'ws:worker-3',
      text: 'unrelated',
    })
    expect(store.getRun(run.id)?.agentCount).toBe(2)
    expect(store.listWorkspaceRuns('ws').find((r) => r.id === run.id)?.agentCount).toBe(2)
  })

  test('hasRunningTopLevelRun is true only for a running parent-less run of that script', () => {
    const store = make()
    expect(store.hasRunningTopLevelRun('ws', 'slow.ts')).toBe(false)
    const run = store.createRun({ workspaceId: 'ws', scriptPath: 'slow.ts', name: 'slow' })
    expect(store.hasRunningTopLevelRun('ws', 'slow.ts')).toBe(true)
    expect(store.hasRunningTopLevelRun('ws', 'other.ts')).toBe(false)
    store.createRun({
      workspaceId: 'ws',
      scriptPath: 'slow.ts',
      name: 'child',
      parentRunId: run.id,
    })
    store.updateRun(run.id, { status: 'completed', finishedAt: 1 })
    expect(store.hasRunningTopLevelRun('ws', 'slow.ts')).toBe(false)
  })
})
