# M1 Slice D — Ephemeral Worker Cleanup (cascade + boot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Ephemeral workers must not leak. Two cleanup paths (spec §6.3): (1) **boot cleanup** — on runtime start, remove every ephemeral worker (its spawner is, by definition, gone after a restart); (2) **cascade** — when an orchestrator's PTY exits, dismiss the ephemeral workers it spawned (`spawnedBy: 'orchestrator'`).

**Architecture:** Add a shared `removeWorkerCompletely(workspaceId, workerId)` in `runtime-store-helpers.ts` that mirrors `runtime-store.deleteWorker` (stop active run → delete launch config → delete dispatches → delete worker row, in a db transaction). Call it from a new boot step (after the workspace store seeds) for all ephemeral workers, and from the existing `onAgentExit` callback when the exited agent is an orchestrator (for its `spawnedBy:'orchestrator'` ephemeral children).

**Tech Stack:** TypeScript, Vitest, Biome. Builds on M1-A/B/C. No new deps.

**Spec references:** §6.3 lifecycle rules.

## Background facts (verified)

- `runtime-store-helpers.ts:95-107` constructs `agentRuntime` with an `onAgentExit(workspaceId, agentId)` callback (currently: detach output tracker + `markAgentStopped`). This fires on every PTY exit.
- `runtime-store.deleteWorker` (runtime-store.ts:146-154): `if active run → stopAgentRun`; `agentRuntime.deleteAgentLaunchConfig`; `runDataMutation(() => { dispatchLedgerStore.deleteWorkerDispatches; workspaceStore.deleteWorker })`.
- Helpers scope has: `db` (line 62), `services`-equivalent locals (`workspaceStore`, `agentRuntime`, `dispatchLedgerStore`, `workerOutputTracker`), and `getOrchestratorId`/`isWorkerAgent`/`getWorkflowAgentId` importable from `workspace-store-support.js`.
- `AgentSummary` now carries `ephemeral`/`spawnedBy` (M1-A); `getWorkspaceSnapshot(ws).agents` exposes them.
- Boot order: `workspaceStore = createWorkspaceStore(...)` (line 80) → `startExistingWorkspaceWatches()` (line 121). Boot cleanup must run AFTER the store is seeded.

## File structure

- Modify: `src/server/runtime-store-helpers.ts` — add `removeWorkerCompletely`, a `cleanupOrphanEphemeralWorkers()` boot step, and cascade logic in `onAgentExit`.
- Test: `tests/server/ephemeral-cleanup.test.ts`.

---

## Task 1: shared `removeWorkerCompletely` + boot cleanup

**Files:** `src/server/runtime-store-helpers.ts`; Test: `tests/server/ephemeral-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'

const dirs: string[] = []
const wsPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'hive-ephem-'))
  mkdirSync(join(d, 'ws'), { recursive: true })
  dirs.push(d)
  return { dataDir: d, workspacePath: join(d, 'ws') }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

describe('ephemeral worker boot cleanup', () => {
  test('ephemeral workers are removed when the runtime restarts; persistent workers survive', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store1 = createRuntimeStore({ dataDir })
    const ws = store1.createWorkspace(workspacePath, 'WS')
    store1.addWorker(ws.id, { name: 'alice', role: 'coder' }) // persistent
    store1.addWorkerWithLaunch(
      ws.id,
      { name: 'verify-1', role: 'reviewer', ephemeral: true, spawnedBy: 'workflow' },
      { command: 'claude', args: [] }
    )
    await store1.close()

    // Restart over the SAME data dir → boot cleanup runs.
    const store2 = createRuntimeStore({ dataDir })
    const names = store2.listWorkers(ws.id).map((w) => w.name)
    expect(names).toContain('alice')
    expect(names).not.toContain('verify-1')
    await store2.close()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/server/ephemeral-cleanup.test.ts`
Expected: FAIL — `verify-1` is still present after restart (no boot cleanup yet).

- [ ] **Step 3: Add `removeWorkerCompletely` + boot cleanup**

In `runtime-store-helpers.ts`, after `workspaceStore` is created (line 80) and `db` is in scope, add:

```ts
  const removeWorkerCompletely = (workspaceId: string, workerId: string) => {
    const activeRun = agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
    if (activeRun) agentRuntime.stopAgentRun(activeRun.runId)
    agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
    db.transaction(() => {
      dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
      workspaceStore.deleteWorker(workspaceId, workerId)
    })()
  }

  const cleanupOrphanEphemeralWorkers = () => {
    for (const workspace of workspaceStore.listWorkspaces()) {
      const ephemeral = workspaceStore
        .getWorkspaceSnapshot(workspace.id)
        .agents.filter((agent) => agent.ephemeral === true)
      for (const agent of ephemeral) removeWorkerCompletely(workspace.id, agent.id)
    }
  }
```

Call `cleanupOrphanEphemeralWorkers()` right before `startExistingWorkspaceWatches()` (so watches start on the cleaned set). NOTE: `agentRuntime` / `dispatchLedgerStore` must be in scope at that point — if `cleanupOrphanEphemeralWorkers` is defined after `agentRuntime` (line 95+), place the call after `agentRuntime` exists but before/with `startExistingWorkspaceWatches()` (line 121). Define `removeWorkerCompletely` after `agentRuntime`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/server/ephemeral-cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime-store-helpers.ts tests/server/ephemeral-cleanup.test.ts
git commit -m "Remove orphan ephemeral workers on runtime boot"
```

---

## Task 2: cascade on orchestrator exit

**Files:** `src/server/runtime-store-helpers.ts`; Test: extend `tests/server/ephemeral-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the file (uses the real store; drive the orchestrator's exit by stopping its run):

```ts
import { getOrchestratorId } from '../../src/server/workspace-store-support.js'

describe('ephemeral worker cascade on orchestrator exit', () => {
  test('orchestrator-spawned ephemeral workers are dismissed when the orchestrator exits', async () => {
    const { dataDir, workspacePath } = wsPath()
    const store = createRuntimeStore({ dataDir })
    try {
      const ws = store.createWorkspace(workspacePath, 'WS')
      store.addWorkerWithLaunch(
        ws.id,
        { name: 'orch-child', role: 'reviewer', ephemeral: true, spawnedBy: 'orchestrator' },
        { command: 'claude', args: [] }
      )
      store.addWorker(ws.id, { name: 'persistent', role: 'coder' }) // must survive

      // Simulate the orchestrator PTY exiting by invoking the runtime's
      // exit notification path. (See implementer note: expose a test seam
      // or drive a real start+stop of the orchestrator.)
      store.notifyAgentExitedForTest?.(ws.id, getOrchestratorId(ws.id))

      const names = store.listWorkers(ws.id).map((w) => w.name)
      expect(names).toContain('persistent')
      expect(names).not.toContain('orch-child')
    } finally {
      await store.close()
    }
  })
})
```

> Implementer note: prefer NOT adding a test-only seam to the public store. Instead, test the cascade by starting a real orchestrator (dummy `/bin/bash` passive script via the agent-launch config), then `stopAgentRun` on it, and `waitFor` the child removal — mirroring `tests/server/team-api-authz.test.ts`'s start pattern (no node-pty mock). If that proves heavy, an acceptable alternative is a focused unit test of an extracted `cascadeDismissOnExit(workspaceId, agentId)` pure-ish function exported from a small module, called by `onAgentExit`. Choose the real-PTY integration test if it's stable; otherwise extract + unit-test the cascade function directly. Do NOT mock node-pty in `tests/server`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/server/ephemeral-cleanup.test.ts`
Expected: FAIL — `orch-child` survives the orchestrator exit.

- [ ] **Step 3: Implement cascade in `onAgentExit`**

Extend the `onAgentExit` callback (runtime-store-helpers.ts:100-104). After the existing detach + `markAgentStopped`, add: if the exited `agentId` is the workspace orchestrator, dismiss its ephemeral children.

```ts
    (workspaceId, agentId) => {
      workerOutputTracker?.detach(workspaceId, agentId)
      if (!workspaceStore.hasAgent(workspaceId, agentId)) return
      workspaceStore.markAgentStopped(workspaceId, agentId)
      if (agentId === getOrchestratorId(workspaceId)) {
        const children = workspaceStore
          .getWorkspaceSnapshot(workspaceId)
          .agents.filter((a) => a.ephemeral === true && a.spawnedBy === 'orchestrator')
        for (const child of children) removeWorkerCompletely(workspaceId, child.id)
      }
    },
```

`removeWorkerCompletely` and `getOrchestratorId` must be in scope (define `removeWorkerCompletely` before `createAgentRuntime`, or hoist via `function`; import `getOrchestratorId`). Because `removeWorkerCompletely` references `agentRuntime`, and `agentRuntime`'s construction references `onAgentExit` which references `removeWorkerCompletely` — break the cycle by declaring `removeWorkerCompletely` as a `function` declaration (hoisted) or by having `onAgentExit` call it lazily (it only runs at exit time, after `agentRuntime` exists). A `const` arrow defined after `agentRuntime` but referenced inside the `onAgentExit` closure works because the closure runs later — but the arrow must be declared before any exit can fire. Place the `const removeWorkerCompletely = ...` immediately AFTER `createAgentRuntime(...)` returns and BEFORE `startExistingWorkspaceWatches()`; the `onAgentExit` closure captures it by reference and only invokes it at runtime. If TS complains about use-before-declaration in the closure, convert `removeWorkerCompletely` to a hoisted `function`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/server/ephemeral-cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime-store-helpers.ts tests/server/ephemeral-cleanup.test.ts
git commit -m "Cascade-dismiss orchestrator-spawned ephemeral workers on its exit"
```

---

## Task 3: regression gate + push

- [ ] `pnpm check && pnpm test` — biome clean + all green.
- [ ] `git push private feat/workflow-runtime`.

## Self-review

- **Spec coverage:** §6.3 boot cleanup → Task 1; §6.3 cascade-on-exit → Task 2.
- **Reuse:** `removeWorkerCompletely` mirrors `runtime-store.deleteWorker` exactly (stop run → del config → del dispatches → del worker, transactional) — consider later refactoring `deleteWorker` to call it (out of scope here to avoid churn).
- **Scope guard:** cleanup only targets `ephemeral === true`; persistent + the orchestrator/`__workflow__` pseudo-agents are untouched (`isWorkerAgent`/role filters not even needed since pseudo-agents are never `ephemeral`).
- **Closure ordering:** documented in Task 2 Step 3 — `removeWorkerCompletely` must exist before any exit can fire.

## Downstream

- **M1-E (events + UI):** `worker_spawned`/`worker_dismissed` events + frontend source badges/animation + web handling of the `'workflow'` role + `ephemeral`/`spawnedBy` (spec §12). After M1-E, M1 is complete; then **M2** (the workflow runtime/DSL — the core feature).
