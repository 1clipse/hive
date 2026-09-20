# M1 Slice A — Data Model + Atomic Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the persistence foundation for workflow-spawned ephemeral workers: migration v19 (ephemeral/spawned_by on `workers`, workflow_run_id/step_index on `dispatches`), thread those fields through the worker type + store, and add an atomic `addWorkerWithLaunch` so a spawn can never persist a worker without its launch config.

**Architecture:** Follows the existing factored-migration pattern (`sqlite-schema-vN.ts` + `applySchemaVersionN`, idempotent PRAGMA-guarded ALTERs). `WorkerInput`/`AgentSummary` gain optional `ephemeral`/`spawnedBy`; `workspace-store.addWorker` persists+hydrates them; `runtime-store.addWorkerWithLaunch` wraps `addWorker` + `configureAgentLaunch` in the existing `runDataMutation` transaction with in-memory rollback on failure.

**Tech Stack:** better-sqlite3, TypeScript, Vitest, Biome. No new deps.

**Spec references:** §6.1 (atomic spawn / gap #1), §6.2 (ephemeral flag), §9 (migration v19). This is the foundation for M1 slices B–D.

---

## Background facts (verified)

- `src/server/sqlite-schema.ts`: `CURRENT_SCHEMA_VERSION = 18`; migrations 14–18 are `applySchemaVersionN(db)` imported from `sqlite-schema-vN.ts`; each `if (!appliedVersions.has(N))` block calls the fn then inserts the version row. The last block is v18 (line ~244).
- `workers` table: `(id, workspace_id, name, description, last_session_id, role, created_at)`.
- `dispatches` table: `(sequence, id, workspace_id, from_agent_id, to_agent_id, text, status, created_at, delivered_at, submitted_at, reported_at, report_text, artifacts)`.
- `workspace-store.ts addWorker` INSERTs `(id, workspace_id, name, description, role, created_at)` and pushes an `AgentSummary` into `workspace.agents`.
- `AgentSummary` (`src/shared/types.ts`): `{ id, workspaceId, name, description, role, status, pendingTaskCount }`.
- `WorkerInput` (`src/server/workspace-store-contract.ts`): `{ description?, name, role }`.
- `runtime-store.ts`: `runDataMutation(mutation)` runs `mutation` inside `db.transaction` when a db is present; `addWorker` delegates to `workspaceStore.addWorker`; `configureAgentLaunch`/`peekAgentLaunchConfig` delegate to `agentRuntime`.
- Worker hydration reads rows in `workspace-store-hydration.ts` (PRAGMA-tolerant column reads).

## File structure

- Create: `src/server/sqlite-schema-v19.ts` — `applySchemaVersion19(db)`.
- Modify: `src/server/sqlite-schema.ts` — import + apply v19; bump `CURRENT_SCHEMA_VERSION` to 19.
- Modify: `src/shared/types.ts` — add `ephemeral?: boolean` and `spawnedBy?: WorkerSpawnSource` to `AgentSummary`; add `WorkerSpawnSource` type.
- Modify: `src/server/workspace-store-contract.ts` — add `ephemeral?`/`spawnedBy?` to `WorkerInput`.
- Modify: `src/server/workspace-store.ts` — persist ephemeral/spawned_by in `addWorker` INSERT + the in-memory `AgentSummary`.
- Modify: `src/server/workspace-store-hydration.ts` — read ephemeral/spawned_by back.
- Modify: `src/server/runtime-store.ts` + `src/server/runtime-store-helpers.ts` + contract — add `addWorkerWithLaunch`.
- Test: `tests/unit/sqlite-schema-v19.test.ts`, `tests/server/workspace-store-ephemeral.test.ts`, `tests/server/add-worker-with-launch.test.ts`.

---

## Task 1: Migration v19 (additive columns + index)

**Files:**
- Create: `src/server/sqlite-schema-v19.ts`
- Modify: `src/server/sqlite-schema.ts:16` (constant) and the migration block (after the v18 block, ~line 247)
- Test: `tests/unit/sqlite-schema-v19.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { initializeRuntimeDatabase, CURRENT_SCHEMA_VERSION } from '../../src/server/sqlite-schema.js'

const columns = (db: Database.Database, table: string) =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  )

describe('schema v19', () => {
  test('adds ephemeral/spawned_by to workers and workflow_run_id/step_index to dispatches', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const workerCols = columns(db, 'workers')
    expect(workerCols.has('ephemeral')).toBe(true)
    expect(workerCols.has('spawned_by')).toBe(true)
    const dispatchCols = columns(db, 'dispatches')
    expect(dispatchCols.has('workflow_run_id')).toBe(true)
    expect(dispatchCols.has('step_index')).toBe(true)
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19)
    db.close()
  })

  test('is idempotent on a second initialize', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    expect(() => initializeRuntimeDatabase(db)).not.toThrow()
    const applied = (
      db.prepare('SELECT version FROM schema_version WHERE version = 19').all() as unknown[]
    ).length
    expect(applied).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sqlite-schema-v19.test.ts`
Expected: FAIL — `workers` has no `ephemeral` column; `CURRENT_SCHEMA_VERSION` is 18.

- [ ] **Step 3: Create the v19 migration file**

`src/server/sqlite-schema-v19.ts`:

```ts
import type { Database } from 'better-sqlite3'

export const applySchemaVersion19 = (db: Database) => {
  const workerColumns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as Array<{ name: string }>).map((c) => c.name)
  )
  if (!workerColumns.has('ephemeral')) {
    db.exec('ALTER TABLE workers ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0')
  }
  if (!workerColumns.has('spawned_by')) {
    db.exec('ALTER TABLE workers ADD COLUMN spawned_by TEXT')
  }

  const dispatchColumns = new Set(
    (db.prepare('PRAGMA table_info(dispatches)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  )
  if (!dispatchColumns.has('workflow_run_id')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN workflow_run_id TEXT')
  }
  if (!dispatchColumns.has('step_index')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN step_index INTEGER')
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_dispatches_workflow ON dispatches (workflow_run_id, step_index)'
  )
}
```

- [ ] **Step 4: Wire it into `sqlite-schema.ts`**

Add the import (after the v18 import, line ~15):

```ts
import { applySchemaVersion19 } from './sqlite-schema-v19.js'
```

Bump the constant (line 16):

```ts
export const CURRENT_SCHEMA_VERSION = 19
```

Add the migration block immediately after the v18 block (before the closing `}` at ~line 248):

```ts
  if (!appliedVersions.has(19)) {
    applySchemaVersion19(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(19, Date.now())
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/sqlite-schema-v19.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/sqlite-schema-v19.ts src/server/sqlite-schema.ts tests/unit/sqlite-schema-v19.test.ts
git commit -m "Add schema v19: ephemeral workers + workflow dispatch columns"
```

---

## Task 2: Thread `ephemeral`/`spawnedBy` through the worker type + store

**Files:**
- Modify: `src/shared/types.ts` (add `WorkerSpawnSource`, extend `AgentSummary`)
- Modify: `src/server/workspace-store-contract.ts` (extend `WorkerInput`)
- Modify: `src/server/workspace-store.ts` (`addWorker` INSERT + summary)
- Modify: `src/server/workspace-store-hydration.ts` (read columns back)
- Test: `tests/server/workspace-store-ephemeral.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceStore } from '../../src/server/workspace-store.js'

const makeStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createWorkspaceStore(db) }
}

describe('workspace-store ephemeral workers', () => {
  test('persists ephemeral + spawnedBy and round-trips through a fresh hydration', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/x', 'X')
    const worker = store.addWorker(ws.id, {
      name: 'verify-1',
      role: 'reviewer',
      ephemeral: true,
      spawnedBy: 'workflow',
    })
    expect(worker.ephemeral).toBe(true)
    expect(worker.spawnedBy).toBe('workflow')

    // Fresh store over the SAME db forces a DB read (hydration), not the cache.
    const store2 = createWorkspaceStore(db)
    const rehydrated = store2.getWorker(ws.id, worker.id)
    expect(rehydrated.ephemeral).toBe(true)
    expect(rehydrated.spawnedBy).toBe('workflow')
    db.close()
  })

  test('defaults to non-ephemeral for a normal worker', () => {
    const { db, store } = makeStore()
    const ws = store.createWorkspace('/tmp/y', 'Y')
    const worker = store.addWorker(ws.id, { name: 'alice', role: 'coder' })
    expect(worker.ephemeral ?? false).toBe(false)
    expect(worker.spawnedBy ?? null).toBe(null)
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/server/workspace-store-ephemeral.test.ts`
Expected: FAIL — `addWorker` ignores `ephemeral`/`spawnedBy`; `worker.ephemeral` is `undefined`, and the rehydrated worker lacks the fields.

- [ ] **Step 3: Add the type**

In `src/shared/types.ts`, after `WorkerRole` (line 5):

```ts
export type WorkerSpawnSource = 'workflow' | 'orchestrator'
```

Extend `AgentSummary` (add two optional fields):

```ts
export interface AgentSummary {
  id: string
  workspaceId: string
  name: string
  description: string
  role: WorkerRole | 'orchestrator'
  status: AgentStatus
  pendingTaskCount: number
  ephemeral?: boolean
  spawnedBy?: WorkerSpawnSource | null
}
```

In `src/server/workspace-store-contract.ts`, extend `WorkerInput`:

```ts
import type { AgentSummary, WorkerRole, WorkerSpawnSource } from '../shared/types.js'
// ...
export interface WorkerInput {
  description?: string
  name: string
  role: WorkerRole
  ephemeral?: boolean
  spawnedBy?: WorkerSpawnSource
}
```

- [ ] **Step 4: Persist in `addWorker`**

In `src/server/workspace-store.ts` `addWorker`, build the summary and INSERT with the two new columns:

```ts
    addWorker(workspaceId, input) {
      const workspace = getWorkspace(workspaceId)
      const name = normalizeWorkerName(input.name)
      if (workspace.agents.some((agent) => agent.name === name && isWorkerAgent(agent))) {
        throw new ConflictError(`Worker name already exists: ${name}`)
      }
      const worker: AgentSummary = {
        id: randomUUID(),
        workspaceId,
        name,
        description: input.description ?? getDefaultRoleDescription(input.role),
        role: input.role,
        status: 'stopped',
        pendingTaskCount: 0,
        ephemeral: input.ephemeral ?? false,
        spawnedBy: input.spawnedBy ?? null,
      }
      db.prepare(
        'INSERT INTO workers (id, workspace_id, name, description, role, ephemeral, spawned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        worker.id,
        workspaceId,
        worker.name,
        worker.description,
        worker.role,
        worker.ephemeral ? 1 : 0,
        worker.spawnedBy,
        Date.now()
      )
      workspace.agents.push(worker)
      return worker
    },
```

- [ ] **Step 5: Read columns back in hydration**

In `src/server/workspace-store-hydration.ts`, locate the worker-row → `AgentSummary` mapping (the SELECT from `workers`). Add the two columns to the SELECT and the mapping. Read with PRAGMA tolerance if the existing code already selects `*`; otherwise extend the column list. The mapped summary must set:

```ts
        ephemeral: row.ephemeral === 1,
        spawnedBy: (row.spawned_by as WorkerSpawnSource | null) ?? null,
```

(Implementer: match the existing row type + mapping shape in this file — it currently maps `id/workspace_id/name/description/role`. Add `ephemeral`/`spawned_by` to both the `SELECT` and the row interface, importing `WorkerSpawnSource` from `../shared/types.js`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/server/workspace-store-ephemeral.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server/workspace-store-contract.ts src/server/workspace-store.ts src/server/workspace-store-hydration.ts tests/server/workspace-store-ephemeral.test.ts
git commit -m "Thread ephemeral + spawnedBy through the worker type and store"
```

---

## Task 3: Atomic `addWorkerWithLaunch`

**Files:**
- Modify: `src/server/runtime-store.ts` (implement + expose), `src/server/runtime-store-helpers.ts` (if the helper belongs there), and the runtime-store contract type
- Test: `tests/server/add-worker-with-launch.test.ts`

- [ ] **Step 1: Write the failing test**

The helper must (a) create the worker AND its launch config together, and (b) leave NO worker behind if the launch config write throws.

```ts
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

// Build a runtime store backed by an in-memory db and no agent manager
// (we only exercise the data layer + launch-config persistence here).
const makeStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createRuntimeStore({ db /* + the store's required deps; see makeRuntimeStore test helpers */ })
}

afterEach(() => vi.restoreAllMocks())

describe('addWorkerWithLaunch', () => {
  test('creates the worker and its launch config together', () => {
    const store = makeStore()
    const ws = store.createWorkspace('/tmp/a', 'A')
    const worker = store.addWorkerWithLaunch(
      ws.id,
      { name: 'verify-1', role: 'reviewer', ephemeral: true, spawnedBy: 'workflow' },
      { command: 'claude', args: [] }
    )
    expect(store.peekAgentLaunchConfig(ws.id, worker.id)).toMatchObject({ command: 'claude' })
    expect(store.getWorker(ws.id, worker.id).ephemeral).toBe(true)
  })

  test('rolls back the worker when the launch config write fails (no orphan)', () => {
    const store = makeStore()
    const ws = store.createWorkspace('/tmp/b', 'B')
    vi.spyOn(store, 'configureAgentLaunch').mockImplementation(() => {
      throw new Error('launch config write failed')
    })
    expect(() =>
      store.addWorkerWithLaunch(ws.id, { name: 'verify-2', role: 'reviewer' }, {
        command: 'claude',
        args: [],
      })
    ).toThrow(/launch config write failed/)
    // No orphan worker left behind.
    expect(store.listWorkers(ws.id).some((w) => w.name === 'verify-2')).toBe(false)
  })
})
```

> Implementer note: use the existing runtime-store test harness/factory the other `tests/server/*` runtime-store tests use to construct `createRuntimeStore` with its real dependency set + an in-memory db (search `tests/server` for the existing constructor usage). Do NOT mock node-pty.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/server/add-worker-with-launch.test.ts`
Expected: FAIL — `store.addWorkerWithLaunch` is not a function.

- [ ] **Step 3: Add `addWorkerWithLaunch` to the runtime-store contract**

In the runtime-store contract/interface (the `RuntimeStore` type in `src/server/runtime-store.ts`), add:

```ts
  addWorkerWithLaunch: (
    workspaceId: string,
    input: WorkerInput,
    launchConfig: AgentLaunchConfigInput
  ) => AgentSummary
```

- [ ] **Step 4: Implement it with transaction + in-memory rollback**

In `src/server/runtime-store.ts`, alongside `addWorker` (line ~143):

```ts
    addWorkerWithLaunch: (workspaceId, input, launchConfig) => {
      let worker: AgentSummary | undefined
      try {
        runDataMutation(() => {
          worker = services.workspaceStore.addWorker(workspaceId, input)
          services.agentRuntime.configureAgentLaunch(workspaceId, worker.id, launchConfig)
        })
      } catch (error) {
        // runDataMutation rolls back the DB rows, but the in-memory worker was
        // already pushed into workspace.agents by addWorker — remove it so the
        // cache matches the rolled-back DB.
        if (worker) services.workspaceStore.deleteWorker(workspaceId, worker.id)
        throw error
      }
      if (!worker) throw new Error('addWorkerWithLaunch produced no worker')
      return worker
    },
```

> Note: `deleteWorker` here is the workspace-store's in-memory+DB delete; after a rolled-back transaction the DB row is already gone, so this primarily prunes the in-memory array. If `workspaceStore.deleteWorker` requires the row to exist in DB, guard with try/catch around the cleanup (swallow), since the goal is only to drop the stale in-memory entry.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/server/add-worker-with-launch.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime-store.ts tests/server/add-worker-with-launch.test.ts
git commit -m "Add atomic addWorkerWithLaunch so a spawn never orphans a worker"
```

---

## Task 4: Regression gate

- [ ] **Step 1: Run the gate**

Run: `pnpm check && pnpm test`
Expected: Biome clean; all tests pass (existing workspace-store / hydration / dispatch tests stay green — new columns are additive and default to non-ephemeral).

- [ ] **Step 2: Commit any incidental fix (only if needed)**

```bash
git add -A && git commit -m "Fix fallout from the ephemeral worker data model"
```

---

## Self-review

- **Spec coverage:** §9 v19 columns+index → Task 1. §6.2 ephemeral flag → Task 2. §6.1 atomic spawn (gap #1) → Task 3.
- **Placeholder scan:** Task 2 Step 5 and Task 3 Step 1 contain implementer notes pointing at existing patterns rather than full code, because the exact row-mapping shape in `workspace-store-hydration.ts` and the runtime-store test factory must be matched in-place; everything else is complete code. These are deliberate "match the existing pattern" pointers, not TBDs — flagged here so the executor reads those two files first.
- **Type consistency:** `WorkerSpawnSource` defined once (types.ts) and reused in `WorkerInput`, `AgentSummary`, hydration, and the `addWorkerWithLaunch` signature. `ephemeral` stored as INTEGER (0/1), exposed as boolean. `CURRENT_SCHEMA_VERSION` bumped to 19 consistently with the new migration block.

## Downstream (next slices, not in this plan)

- **M1-B:** `__workflow__` pseudo-agent provisioning + dispatch `from_agent_id` rendering (spec §7), and wiring `workflow_run_id`/`step_index` on dispatch creation.
- **M1-C:** `team spawn` / `team dismiss` CLI verbs + routes + authz; cascade-on-PTY-exit + boot cleanup of orphan ephemeral workers (spec §6.3).
- **M1-D:** `worker_spawned` / `worker_dismissed` events + frontend source badges/animation (spec §12).
