# M1 Slice B — `__workflow__` Pseudo-Agent + Dispatch Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the (PTY-less) workflow runner a first-class dispatch identity so its `team`-style dispatches have a valid `from_agent_id` and render a sensible sender name, and let dispatches carry `workflow_run_id`/`step_index`.

**Architecture:** Mirror the existing in-memory `orchestrator` pseudo-agent: add a per-workspace `__workflow__` pseudo-agent (role `'workflow'`, no DB row, no PTY) to every workspace's `agents` array on create + hydrate. Exclude it from `isWorkerAgent` so it never shows in the worker roster/UI. Extend the dispatch ledger's `createDispatch` to persist the v19 `workflow_run_id`/`step_index` columns.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Biome. No new deps. Builds on M1-A (schema v19 columns already exist).

**Spec references:** §7 (dispatch identity), §9 (workflow_run_id/step_index).

## Background facts (verified)

- `workspace-store-support.ts`: `getOrchestratorId(ws) = ${ws}:orchestrator`; `createOrchestrator(ws)` returns an in-memory `AgentSummary` (role `'orchestrator'`, not persisted); `isWorkerAgent(a) = a.role !== 'orchestrator'`.
- `createOrchestrator` is injected into every workspace's `agents` in `workspace-store.ts createWorkspace` and in both hydration paths (`hydrateWorkspaceFromDb`, `seedWorkspacesFromDb`).
- `AgentSummary.role: WorkerRole | 'orchestrator'` (`src/shared/types.ts`).
- `getDefaultRoleDescription(role: WorkerRole | 'orchestrator')` is only ever called with a real worker role or `'orchestrator'` — NOT with the new pseudo-role, so its signature is unchanged.
- `dispatch-ledger-store.ts createDispatch` INSERTs an explicit 12-column list; `DispatchRecord`/`DispatchRow` have no workflow fields yet.
- `team-operations.ts dispatchTask` resolves the sender via `workspaceStore.getAgent(ws, input.fromAgentId)` then uses `sender.name` in the dispatch payload — so a `__workflow__` agent resolvable by `getAgent` renders correctly.

## File structure

- Modify: `src/shared/types.ts` — widen agent role to include `'workflow'`.
- Modify: `src/server/workspace-store-support.ts` — `getWorkflowAgentId`, `createWorkflowAgent`, exclude `'workflow'` from `isWorkerAgent`.
- Modify: `src/server/workspace-store.ts` — add the pseudo-agent in `createWorkspace`.
- Modify: `src/server/workspace-store-hydration.ts` — add the pseudo-agent in both hydration paths.
- Modify: `src/server/dispatch-ledger-store.ts` — `createDispatch` accepts + persists `workflowRunId`/`stepIndex`; expose on `DispatchRecord`.
- Test: `tests/server/workflow-pseudo-agent.test.ts`, `tests/server/dispatch-workflow-fields.test.ts`.

---

## Task 1: `__workflow__` pseudo-agent

**Files:**
- Modify: `src/shared/types.ts`, `src/server/workspace-store-support.ts`, `src/server/workspace-store.ts`, `src/server/workspace-store-hydration.ts`
- Test: `tests/server/workflow-pseudo-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/server/workflow-pseudo-agent.test.ts`
Expected: FAIL — `getWorkflowAgentId` is not exported; `getAgent` throws "Agent not found".

- [ ] **Step 3: Widen the role union**

`src/shared/types.ts` — change `AgentSummary.role`:

```ts
  role: WorkerRole | 'orchestrator' | 'workflow'
```

- [ ] **Step 4: Add the pseudo-agent factory + roster exclusion**

`src/server/workspace-store-support.ts` (near `createOrchestrator`):

```ts
export const getWorkflowAgentId = (workspaceId: string) => `${workspaceId}:__workflow__`

export const createWorkflowAgent = (workspaceId: string): AgentSummary => ({
  id: getWorkflowAgentId(workspaceId),
  workspaceId,
  name: 'Workflow',
  description: 'Hive workflow runner — deterministic multi-agent orchestration driver.',
  role: 'workflow',
  status: 'stopped',
  pendingTaskCount: 0,
})
```

Update `isWorkerAgent` to exclude both pseudo-roles:

```ts
export const isWorkerAgent = (
  agent: AgentSummary
): agent is AgentSummary & { role: WorkerRole } => {
  return agent.role !== 'orchestrator' && agent.role !== 'workflow'
}
```

- [ ] **Step 5: Provision the pseudo-agent on create + hydrate**

`src/server/workspace-store.ts` `createWorkspace` — add it alongside the orchestrator:

```ts
      workspaces.set(summary.id, {
        summary,
        agents: [createOrchestrator(summary.id), createWorkflowAgent(summary.id)],
      })
```

(Import `createWorkflowAgent` from `./workspace-store-support.js`.)

`src/server/workspace-store-hydration.ts` — in BOTH `hydrateWorkspaceFromDb` and `seedWorkspacesFromDb`, where the workspace record is seeded with `agents: [createOrchestrator(row.id)]`, change to:

```ts
      agents: [createOrchestrator(row.id), createWorkflowAgent(row.id)],
```

(Import `createWorkflowAgent` from `./workspace-store-support.js`.)

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run tests/server/workflow-pseudo-agent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server/workspace-store-support.ts src/server/workspace-store.ts src/server/workspace-store-hydration.ts tests/server/workflow-pseudo-agent.test.ts
git commit -m "Add the __workflow__ pseudo-agent for workflow dispatch identity"
```

---

## Task 2: persist `workflow_run_id` / `step_index` on dispatches

**Files:**
- Modify: `src/server/dispatch-ledger-store.ts`
- Test: `tests/server/dispatch-workflow-fields.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/server/dispatch-workflow-fields.test.ts`
Expected: FAIL — `createDispatch` ignores the fields; `created.workflowRunId` is `undefined`.

- [ ] **Step 3: Extend the record + row types**

`src/server/dispatch-ledger-store.ts` — add to `DispatchRecord`:

```ts
  workflowRunId: string | null
  stepIndex: number | null
```

add to `DispatchRow`:

```ts
  workflow_run_id: string | null
  step_index: number | null
```

add to `CreateDispatchInput`:

```ts
  workflowRunId?: string
  stepIndex?: number
```

- [ ] **Step 4: Map + persist**

In `toRecord`, add:

```ts
  workflowRunId: row.workflow_run_id,
  stepIndex: row.step_index,
```

In `createDispatch`, set the record fields and extend the INSERT:

```ts
    const record: DispatchRecord = {
      // ...existing fields...
      workflowRunId: input.workflowRunId ?? null,
      stepIndex: input.stepIndex ?? null,
    }

    db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status,
        created_at, delivered_at, submitted_at, reported_at, report_text, artifacts,
        workflow_run_id, step_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.workspaceId,
      record.fromAgentId,
      record.toAgentId,
      record.text,
      record.status,
      record.createdAt,
      record.deliveredAt,
      record.submittedAt,
      record.reportedAt,
      record.reportText,
      JSON.stringify(record.artifacts),
      record.workflowRunId,
      record.stepIndex
    )
```

Also add `workflowRunId`/`stepIndex` to the spread-return objects in `markReportedByWorker` and `markCancelled` if those construct a `DispatchRecord` literal — they spread `...dispatch`, so the fields carry through automatically; verify no explicit field list drops them.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run tests/server/dispatch-workflow-fields.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/dispatch-ledger-store.ts tests/server/dispatch-workflow-fields.test.ts
git commit -m "Persist workflow_run_id and step_index on dispatches"
```

---

## Task 3: regression gate + push

- [ ] **Step 1:** `pnpm check && pnpm test` — expect biome clean + all green. The role-union widening is additive; `isWorkerAgent` change only adds an exclusion. Watch for any server test asserting an exact agents-array length per workspace (now +1 pseudo-agent) — if found, it's a real expectation update (workspaces legitimately have a workflow pseudo-agent now).
- [ ] **Step 2:** Push: `git push private feat/workflow-runtime`.

## Self-review

- **Spec coverage:** §7 pseudo-agent identity → Task 1; §9 dispatch workflow columns → Task 2.
- **Type consistency:** new role `'workflow'` added once to the `AgentSummary.role` union; `getWorkflowAgentId`/`createWorkflowAgent` named consistently; `DispatchRecord.workflowRunId`/`stepIndex` (camelCase) ↔ `workflow_run_id`/`step_index` (snake_case columns) mapped in `toRecord`.
- **Roster safety:** `isWorkerAgent` now excludes `'workflow'`, so `listWorkers` and all worker-iteration paths skip the pseudo-agent (mirrors the orchestrator's exclusion).
- **Watch:** any test asserting `getWorkspaceSnapshot(...).agents.length` or iterating all agents may need +1 for the pseudo-agent — update as a real change.

## Downstream (next slices)

- **M1-C:** `team spawn`/`team dismiss` verbs + routes + authz; cascade-on-PTY-exit + boot cleanup of orphan ephemeral workers.
- **M1-D:** `worker_spawned`/`worker_dismissed` events + frontend source badges/animation; web handling of the new `'workflow'` role + `ephemeral`/`spawnedBy` (badges).
