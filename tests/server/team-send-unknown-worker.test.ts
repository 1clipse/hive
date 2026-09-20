import { describe, expect, test } from 'vitest'

import { ConflictError } from '../../src/server/http-errors.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

/* When the orchestrator dispatches to a name that no longer exists in the
   workspace (worker renamed, deleted, or the orchestrator drew on stale
   memory from before /compact), the failure should be a self-healing 409 —
   not a bare 500. The error body must surface the *current* roster so the
   orchestrator can correct itself in a single follow-up turn without first
   round-tripping a `team list`. This is the protocol-layer half of the
   "team list before team send" invariant; the prompt-layer half lives in
   hive-team-guidance.ts. */
describe('dispatchTaskByWorkerName unknown worker contract', () => {
  test('rejects unknown name as ConflictError(409) and surfaces the current roster', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-alpha', 'Alpha')
    store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    store.addWorker(workspace.id, { name: 'Charlie', role: 'reviewer' })

    let caught: unknown
    try {
      await store.dispatchTaskByWorkerName(workspace.id, 'Bob', 'Implement login', {
        fromAgentId: `${workspace.id}:orchestrator`,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ConflictError)
    const err = caught as ConflictError
    expect(err.statusCode).toBe(409)
    // The name the orchestrator tried — so it sees what it sent.
    expect(err.message).toContain('Bob')
    // Every current member, with role — so the orchestrator can re-pick.
    expect(err.message).toContain('Alice')
    expect(err.message).toContain('coder')
    expect(err.message).toContain('Charlie')
    expect(err.message).toContain('reviewer')
    // Either a direct retry hint or the explicit "run team list" cue —
    // whichever the implementation chose, it must steer somewhere actionable.
    expect(err.message).toMatch(/team send|team list/)
  })

  test('empty-roster case still produces a 409 with a usable next-step hint', async () => {
    const store = createRuntimeStore()
    const workspace = store.createWorkspace('/tmp/hive-empty', 'Empty')
    // No workers added. The orchestrator should not see "Worker not found"
    // alone — it should learn that the workspace is currently worker-less.

    let caught: unknown
    try {
      await store.dispatchTaskByWorkerName(workspace.id, 'Nobody', 'task', {
        fromAgentId: `${workspace.id}:orchestrator`,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).statusCode).toBe(409)
    // The empty-roster body should say so plainly — not echo "current
    // members:" with no entries beneath it (which would be ambiguous
    // between "empty list" and "list section was omitted").
    expect((caught as ConflictError).message).toMatch(/no workers|empty/i)
  })
})
