# M4 — Workflows UI Drawer (V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Make the workflow feature visible and usable from the web UI. V1 MVP scope:

1. List `.hive/workflows/*.ts` scripts with their meta (name, description)
2. Start a run with one click
3. Show recent runs (newest-first) with status + duration

**Out of scope (defer):** progress tree, in-browser editor, schedule UI, real-time updates (V1 polls). Schedules + nested-run trees ship in a follow-up.

**Architecture:** Mirrors the Task Graph drawer pattern (`tasks/TaskGraphDrawer.tsx`): topbar button toggles an overlay drawer that polls every ~2s while open.

**Tech Stack:** React 19, Vite, Tailwind, plain `fetch` via `web/src/api.ts`. Tests in `tests/web/*.test.tsx` (jsdom + real server via `runHiveCommand`).

## File structure

- New: `web/src/workflows/api-workflows.ts` (or extend `api.ts`) — `listWorkflowScripts`, `startWorkflowRun`, `listWorkflowRuns`, `getWorkflowRun`
- New: `web/src/workflows/useWorkflowsPolling.ts` — polls scripts + runs while drawer is open
- New: `web/src/workflows/WorkflowsDrawer.tsx`
- Modify: `web/src/layout/Topbar.tsx` — add a Workflows toggle button (lucide icon `Workflow`)
- Modify: `web/src/AppInner.tsx` — own `[workflowsOpen, setWorkflowsOpen]`, render the drawer
- Test: `tests/web/workflows-flow.test.tsx` — open drawer → see script → click Start → see run appear as running → poll completes

## Public API (web/src/api.ts additions)

```ts
export interface WorkflowScriptListItem {
  scriptPath: string
  meta?: { name: string; description: string }
  scriptHash?: string
  error?: string
}

export interface WorkflowRun {
  id: string
  workspaceId: string
  scriptPath: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'stopped'
  startedAt: number
  finishedAt: number | null
  error: string | null
  phase: string | null
}

export const listWorkflowScripts: (workspaceId: string) => Promise<WorkflowScriptListItem[]>
export const startWorkflowRun: (workspaceId: string, scriptPath: string) => Promise<WorkflowRun>
export const listWorkflowRuns: (workspaceId: string) => Promise<WorkflowRun[]>
export const getWorkflowRun: (runId: string) => Promise<WorkflowRun>
```

---

## Task 1: API client functions

- [ ] Add the four functions above to `web/src/api.ts` matching the existing `apiFetch` + UI-cookie pattern (look at `listWorkers` / `createWorkspace` for the shape — including snake_case → camelCase mapping for `script_path` etc.).
- [ ] No test needed at this layer; the drawer test exercises them end-to-end.
- [ ] Commit: `Add web/src/api workflow client functions`

## Task 2: `useWorkflowsPolling` hook

- [ ] When `enabled === false`, no fetches.
- [ ] When `enabled === true`: initial fetch of both scripts + runs; then poll runs every 2s. Polls only runs (scripts rarely change).
- [ ] Returns `{scripts, runs, refresh, error, loading}`.
- [ ] Commit: `Add useWorkflowsPolling hook`

## Task 3: `WorkflowsDrawer` component

Layout: right-side overlay (mirrors TaskGraphDrawer styling).

```
┌── Workflows ──────────── × ┐
│ Scripts                    │
│  • review-changes          │
│    Review code changes     │
│    [Start]                 │
│  • lint-then-test          │
│    ...                     │
│                            │
│ Recent runs                │
│  ✓ review-changes  3m ago  │
│  ⟳ lint-then-test  running │
│  ✗ broken          2m ago  │
└────────────────────────────┘
```

- Status icons: `Loader2` (animate-spin for running), `CheckCircle` for completed, `XCircle` for failed, `MinusCircle` for interrupted.
- `Start` button → `startWorkflowRun` → immediately refresh runs list.
- Errors per-script (when `error` is set, instead of "Start" show a small "✗ failed to load" with the message in a tooltip).
- No editing, no script CRUD; just discover + start.
- Commit: `Add WorkflowsDrawer component`

## Task 4: Topbar button + AppInner wiring

- [ ] Topbar gets a `workflowsOpen` / `onToggleWorkflows` prop + a button next to the Task Graph button (icon `Workflow` from `lucide-react`).
- [ ] AppInner adds `useState` for `workflowsOpen`, passes through; renders `<WorkflowsDrawer>` when open + the active workspace exists.
- [ ] Demo mode: pass `enabled={false}` so the drawer never fetches in demo mode (matches how Task Graph guards against demo).
- [ ] Commit: `Wire Workflows drawer into AppInner + Topbar`

## Task 5: jsdom flow test

- [ ] `tests/web/workflows-flow.test.tsx`:
  1. Spin up a real server with `runHiveCommand`, a temp workspace, and one `.hive/workflows/echo.ts` (so the noop child completes immediately).
  2. Render `<AppInner>` with the test workspace selected.
  3. Click the Workflows topbar button.
  4. Wait for the script to appear; click Start.
  5. Wait until the runs list shows the run with status === 'completed'.
- [ ] Commit: `Add workflows-flow web test`

## Task 6: gate + push

- [ ] `pnpm check && pnpm test`
- [ ] `git push private feat/workflow-runtime`

## Self-review

- **MVP discipline:** Tasks 3–5 explicitly skip the progress tree, schedule UI, and editor; those are deferred to a follow-up so this slice is shippable.
- **Demo-mode safety:** the drawer is hidden in demo mode (otherwise it would fetch against a non-existent workspace).
- **Web test discipline:** real server, real fetches, no fetch mock.
- **Visibility:** users get end-to-end discoverability + execution from the UI; the rest of the workflow feature (cron, nesting) is invisible until later UI slices.

## Downstream

- **M4.5:** progress tree + real-time run updates (likely via the existing PTY output bus or a new WebSocket channel for dispatches with workflow_run_id)
- **M4.6:** schedules tab (use M3-B CRUD routes)
- **M5:** in-browser editor + template gallery
