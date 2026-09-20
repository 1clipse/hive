# M2 Slice A — `workflow_runs` Store (schema v20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Persistence for workflow runs: migration v20 adds a `workflow_runs` table, and a `workflow-run-store.ts` provides create/update/get/list + a boot step that marks any still-"running" run as "interrupted" (spec §13 — no auto-resume after a runtime restart).

**Architecture:** Mirror the established `dispatch-ledger-store.ts` + factored-migration patterns. Additive migration v20 (`CURRENT_SCHEMA_VERSION → 20`). The store is pure persistence; the runner (M2-C) drives it.

**Tech Stack:** better-sqlite3, TypeScript, Vitest, Biome. No new deps (esbuild arrives in M2-B).

**Spec references:** §9 (workflow_runs / migration v20), §13 (interrupted on restart).

## Background facts (verified)

- Migrations: factored `sqlite-schema-vN.ts` + `applySchemaVersionN(db)`; `CURRENT_SCHEMA_VERSION = 19` (after M1-A); each block `if (!appliedVersions.has(N)) { applySchemaVersionN(db); insert N }`.
- `dispatch-ledger-store.ts` is the store template: a `create*` with explicit INSERT, `toRecord` row→record mapper, list/update methods, `createXStore(db)` factory.
- `agentRunStore.markUnfinishedRunsStale()` (called at boot, runtime-store-helpers.ts:78) is the template for the boot "interrupted" sweep.

## File structure

- Create: `src/server/sqlite-schema-v20.ts` — `applySchemaVersion20(db)`.
- Modify: `src/server/sqlite-schema.ts` — import + apply v20; bump constant to 20.
- Create: `src/server/workflow-run-store.ts` — `createWorkflowRunStore(db)`.
- Test: `tests/unit/sqlite-schema-v20.test.ts`, `tests/server/workflow-run-store.test.ts`.

---

## Task 1: migration v20 (`workflow_runs` table)

**Files:** create `src/server/sqlite-schema-v20.ts`; modify `src/server/sqlite-schema.ts`; test `tests/unit/sqlite-schema-v20.test.ts`

- [ ] **Step 1: failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { CURRENT_SCHEMA_VERSION, initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

describe('schema v20', () => {
  test('creates workflow_runs with the expected columns', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const cols = new Set(
      (db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    for (const col of [
      'id', 'workspace_id', 'script_path', 'script_hash', 'name', 'status',
      'phase', 'args', 'started_at', 'finished_at', 'error', 'created_at',
    ]) {
      expect(cols.has(col)).toBe(true)
    }
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(20)
    db.close()
  })

  test('is idempotent', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    expect(() => initializeRuntimeDatabase(db)).not.toThrow()
    db.close()
  })
})
```

- [ ] **Step 2: run → FAIL** (`no such table: workflow_runs`).

- [ ] **Step 3: create `src/server/sqlite-schema-v20.ts`**

```ts
import type { Database } from 'better-sqlite3'

export const applySchemaVersion20 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      script_path TEXT NOT NULL,
      script_hash TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      args TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace
      ON workflow_runs (workspace_id, created_at);
  `)
}
```

- [ ] **Step 4: wire into `sqlite-schema.ts`** — add `import { applySchemaVersion20 } from './sqlite-schema-v20.js'`; bump `export const CURRENT_SCHEMA_VERSION = 20`; add after the v19 block:

```ts
  if (!appliedVersions.has(20)) {
    applySchemaVersion20(db)
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(20, Date.now())
  }
```

- [ ] **Step 5: run → PASS.**

- [ ] **Step 6: commit** — `git commit -m "Add schema v20: workflow_runs table"`

---

## Task 2: `workflow-run-store.ts`

**Files:** create `src/server/workflow-run-store.ts`; test `tests/server/workflow-run-store.test.ts`

- [ ] **Step 1: failing test**

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkflowRunStore } from '../../src/server/workflow-run-store.js'

const make = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createWorkflowRunStore(db)
}

describe('workflow-run-store', () => {
  test('creates a running run and reads it back', () => {
    const store = make()
    const run = store.createRun({
      workspaceId: 'ws', scriptPath: '.hive/workflows/review.ts',
      scriptHash: 'abc', name: 'review-changes', args: { q: 1 },
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
    store.createRun({ workspaceId: 'ws', scriptPath: 'p', name: 'b' }) // still running
    store.markUnfinishedRunsInterrupted()
    const runs = store.listWorkspaceRuns('ws')
    expect(runs.map((r) => r.name)).toContain('b')
    expect(runs.find((r) => r.name === 'b')?.status).toBe('interrupted')
    expect(runs.find((r) => r.name === 'a')?.status).toBe('completed')
  })
})
```

- [ ] **Step 2: run → FAIL** (`createWorkflowRunStore` not found).

- [ ] **Step 3: implement `src/server/workflow-run-store.ts`**

```ts
import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped'

export interface WorkflowRunRecord {
  id: string
  workspaceId: string
  scriptPath: string
  scriptHash: string | null
  name: string
  status: WorkflowRunStatus
  phase: string | null
  args: unknown
  startedAt: number
  finishedAt: number | null
  error: string | null
  createdAt: number
}

interface WorkflowRunRow {
  id: string
  workspace_id: string
  script_path: string
  script_hash: string | null
  name: string
  status: WorkflowRunStatus
  phase: string | null
  args: string | null
  started_at: number
  finished_at: number | null
  error: string | null
  created_at: number
}

interface CreateRunInput {
  workspaceId: string
  scriptPath: string
  name: string
  scriptHash?: string
  args?: unknown
}

interface UpdateRunInput {
  status?: WorkflowRunStatus
  phase?: string
  finishedAt?: number
  error?: string
}

const parseArgs = (value: string | null): unknown => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const toRecord = (row: WorkflowRunRow): WorkflowRunRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  scriptPath: row.script_path,
  scriptHash: row.script_hash,
  name: row.name,
  status: row.status,
  phase: row.phase,
  args: parseArgs(row.args),
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
  createdAt: row.created_at,
})

export const createWorkflowRunStore = (db: Database) => {
  const createRun = (input: CreateRunInput): WorkflowRunRecord => {
    const now = Date.now()
    const record: WorkflowRunRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      scriptPath: input.scriptPath,
      scriptHash: input.scriptHash ?? null,
      name: input.name,
      status: 'running',
      phase: null,
      args: input.args ?? null,
      startedAt: now,
      finishedAt: null,
      error: null,
      createdAt: now,
    }
    db.prepare(
      `INSERT INTO workflow_runs (
        id, workspace_id, script_path, script_hash, name, status, phase, args,
        started_at, finished_at, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id, record.workspaceId, record.scriptPath, record.scriptHash, record.name,
      record.status, record.phase,
      record.args === null ? null : JSON.stringify(record.args),
      record.startedAt, record.finishedAt, record.error, record.createdAt
    )
    return record
  }

  const updateRun = (id: string, input: UpdateRunInput) => {
    const sets: string[] = []
    const values: Array<string | number> = []
    if (input.status !== undefined) { sets.push('status = ?'); values.push(input.status) }
    if (input.phase !== undefined) { sets.push('phase = ?'); values.push(input.phase) }
    if (input.finishedAt !== undefined) { sets.push('finished_at = ?'); values.push(input.finishedAt) }
    if (input.error !== undefined) { sets.push('error = ?'); values.push(input.error) }
    if (sets.length === 0) return
    values.push(id)
    db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  const getRun = (id: string): WorkflowRunRecord | undefined => {
    const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
      | WorkflowRunRow
      | undefined
    return row ? toRecord(row) : undefined
  }

  const listWorkspaceRuns = (workspaceId: string): WorkflowRunRecord[] =>
    (
      db
        .prepare(
          'SELECT * FROM workflow_runs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC'
        )
        .all(workspaceId) as WorkflowRunRow[]
    ).map(toRecord)

  // Boot sweep: a run still 'running' after a restart can never resume, mark it
  // interrupted (spec §13 — UI offers Resume; we do not auto-resume).
  const markUnfinishedRunsInterrupted = () => {
    db.prepare(
      "UPDATE workflow_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'"
    ).run(Date.now())
  }

  return { createRun, updateRun, getRun, listWorkspaceRuns, markUnfinishedRunsInterrupted }
}
```

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: wire boot sweep** — in `runtime-store-helpers.ts`, construct `const workflowRunStore = createWorkflowRunStore(db)` alongside the other stores, call `workflowRunStore.markUnfinishedRunsInterrupted()` near `agentRunStore.markUnfinishedRunsStale()` (line 78), and add `workflowRunStore` to the returned `RuntimeStoreServices` (so the runner can reach it in M2-C). Add the field to the `RuntimeStoreServices` interface + the return object. (No behavior beyond the sweep yet.)

- [ ] **Step 6: commit** — `git commit -m "Add workflow-run-store with boot interrupted-sweep"`

---

## Task 3: gate + push

- [ ] `pnpm check && pnpm test` — biome clean + green. Watch `schema-version.test.ts` for a table-set/version assertion that may need `workflow_runs`/20 added (update as a real change).
- [ ] `git push private feat/workflow-runtime`.

## Self-review

- **Spec coverage:** §9 v20 table → Task 1; store CRUD + §13 interrupted-sweep → Task 2; boot wiring → Task 2 Step 5.
- **Pattern fidelity:** mirrors `dispatch-ledger-store` (record/row/toRecord/factory) and `markUnfinishedRunsStale` (boot sweep).
- **Type consistency:** `WorkflowRunStatus` defined once; snake_case columns ↔ camelCase record via `toRecord`; `args` stored as JSON text, parsed on read.

## Downstream

- **M2-B:** script loader — add `esbuild` to `dependencies` (B1), read `.hive/workflows/*.ts`, transpile, extract `meta`, compute `script_hash = sha256(output)`.
- **M2-C:** DSL (`agent/parallel/pipeline/phase/log`) + runner + dispatch-await (`workflow:dispatch_observed`).
- **M2-D:** `routes-workflows` (list scripts, start/stop/list runs).
