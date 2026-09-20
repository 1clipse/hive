# M3 Slice B — Cron Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Let users register a `.hive/workflows/*.ts` script to run on a cron schedule. The runtime keeps an in-process scheduler that fires `store.startWorkflow(...)` when each schedule's `next_run_at` arrives.

**Architecture:**
- New schema v21 `workflow_schedules` table (kept in the base CREATE-IF-NOT-EXISTS block per the foreign-DB lesson).
- `workflow-schedule-store.ts` mirrors the `workflow-run-store.ts` pattern: create/update/list/delete + `nextDueBefore(at)` for the scheduler.
- `workflow-scheduler.ts` runs a single `setInterval` tick (default 30s) that queries `listDueSchedules(now)`, fires each via `store.startWorkflow(...)`, and writes back `last_run_at` + recomputed `next_run_at` using `cron-parser`. On runtime close, the tick is cleared and pending fires are dropped (the boot tick catches them on next start).
- Routes mirror M2-D's pattern (UI auth, REST CRUD).

**Tech Stack:** TypeScript, Vitest, Biome, `cron-parser` (new runtime dep, ~30KB).

**Spec references:** §10 cron schedules.

## File structure

- New schema: `src/server/sqlite-schema-v21.ts` + base block addition
- New store: `src/server/workflow-schedule-store.ts`
- New scheduler: `src/server/workflow-scheduler.ts`
- New routes: `src/server/routes-workflow-schedules.ts` (registered in `routes.ts`)
- Modify: `src/server/sqlite-schema.ts`, `src/server/runtime-store-helpers.ts`, `src/server/runtime-store.ts`
- Tests: `tests/unit/sqlite-schema-v21.test.ts`, `tests/server/workflow-schedule-store.test.ts`, `tests/server/workflow-scheduler.test.ts`, `tests/server/routes-workflow-schedules.test.ts`

## Public surface

```ts
interface WorkflowSchedule {
  id: string
  workspaceId: string
  scriptPath: string
  cron: string          // e.g. "0 9 * * 1"
  args: unknown
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number     // computed from cron + lastRunAt
  createdAt: number
  updatedAt: number
}
```

---

## Task 1: schema v21 + workflow_schedules

- [ ] Add `tests/unit/sqlite-schema-v21.test.ts` asserting the table + columns + foreign-DB robustness (mirror the v20 trio of tests).
- [ ] Implement `src/server/sqlite-schema-v21.ts` (`applySchemaVersion21`).
- [ ] Add base CREATE block + version bump to 21 in `sqlite-schema.ts`.
- [ ] Commit: `Add schema v21: workflow_schedules table`

## Task 2: workflow-schedule-store

- [ ] Tests in `tests/server/workflow-schedule-store.test.ts`: create, list, get, update (enable/disable), delete, `listDueSchedules(now)`.
- [ ] Implement `createWorkflowScheduleStore(db)` — same shape as `workflow-run-store`.
- [ ] Wire into `runtime-store-helpers` (services bag) + add 3 store surface methods: `createWorkflowSchedule`, `listWorkspaceSchedules`, `deleteWorkflowSchedule`, `updateWorkflowSchedule`.
- [ ] Commit: `Add workflow-schedule-store with the standard CRUD + listDueSchedules`

## Task 3: cron-parser dep + scheduler service

- [ ] `pnpm add cron-parser`
- [ ] `tests/server/workflow-scheduler.test.ts`: a real-store scheduler with a 1-second tick, a schedule whose nextRunAt is in the past, asserts startWorkflow gets called + lastRunAt/nextRunAt update. Use fake timers to deterministically advance.
- [ ] Implement `createWorkflowScheduler({store, scheduleStore, tickIntervalMs})` that:
  - On `start()`: kicks off `setInterval`
  - On tick: `for each due schedule: store.startWorkflow(...); scheduleStore.update(id, {lastRunAt: now, nextRunAt: computeNext(cron)})`
  - On `close()`: clearInterval
- [ ] Wire scheduler into runtime-store-helpers (constructed alongside other services). Call `scheduler.start()` near `startExistingWorkspaceWatches()`; call `scheduler.close()` in `close()`.
- [ ] Commit: `Add workflow-scheduler tick loop firing due schedules`

## Task 4: HTTP routes

- [ ] `POST /api/workspaces/:workspaceId/workflow-schedules` — create
- [ ] `GET /api/workspaces/:workspaceId/workflow-schedules` — list
- [ ] `PATCH /api/workflow-schedules/:scheduleId` — toggle/edit
- [ ] `DELETE /api/workflow-schedules/:scheduleId` — remove
- [ ] Tests in `tests/server/routes-workflow-schedules.test.ts` (mirrors `tests/server/routes-workflows.test.ts`)
- [ ] Register `workflowScheduleRoutes` in `src/server/routes.ts`
- [ ] Commit: `Add workflow-schedules CRUD routes`

## Task 5: gate + push

- [ ] `pnpm check && pnpm test`
- [ ] `git push private feat/workflow-runtime`

## Self-review

- **Spec coverage:** §10.
- **Foreign-DB robustness:** workflow_schedules table goes into the base CREATE-IF-NOT-EXISTS block AND v21 migration — same dual-path lesson from M1-A/M2-A.
- **Tick safety:** scheduler's tick `await`s `startWorkflow` per schedule sequentially within the tick — concurrent fires would race the runner's per-schedule cron-next recomputation. Sequential is fine; tickInterval defaults to 30s so a slow workflow won't back up.
- **Crash safety:** schedules use cron's "fire at next slot, not catch up missed slots" semantics — if the runtime was down at fire time, the next tick after restart fires the next slot only (not the missed ones). This matches `setInterval` semantics and avoids thundering-herd on restart.

## Downstream

- **M4:** UI for workflows + schedules
- **M5:** template library + in-browser editor
