# M2 Slice D — Workflow HTTP Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Make workflows usable from outside the process. The web UI (M4) and CLI tools need to list scripts, start runs, and observe progress.

**Architecture:**
- `runWorkflow` (the existing blocking-to-completion entry point used by tests) stays as-is.
- A new `startWorkflow` returns the initial `WorkflowRunRecord` immediately and runs the body in the background. The HTTP route uses `startWorkflow`; clients poll `GET .../runs/:runId` to observe progress.
- A small `scanWorkflowScripts(workspacePath)` helper lives next to the script loader and returns `{scriptPath, meta?, scriptHash?, error?}[]` for every `.hive/workflows/*.ts` file (errors per-file, never throws).
- Routes follow the existing `routes-workflows` shape (UI cookie auth), mirroring how routes-workspaces is structured.

**Tech Stack:** TypeScript, Vitest, Biome. No new deps.

**Spec references:** §3 routes, §4 file discovery, §13 runs.

## File structure

- Modify: `src/server/workflow-runner.ts` — extract `executeWorkflow(loaded, run, args, hivePort)` from `runWorkflow`; add `startWorkflow(input): Promise<WorkflowRunRecord>` (returns initial record; runs body in background).
- Modify: `src/server/workflow-script-loader.ts` — add `scanWorkflowScripts(workspacePath)`.
- Modify: `src/server/runtime-store.ts` — expose `startWorkflow`, `listWorkspaceWorkflowRuns`, `getWorkflowRun`, `scanWorkflowScripts(workspaceId)`.
- New: `src/server/routes-workflows.ts` — `GET /api/workspaces/:id/workflows`, `POST .../workflows/runs`, `GET .../workflows/runs`, `GET /api/workflows/runs/:runId`.
- Modify: `src/server/routes.ts` (or wherever routes are aggregated) — register the new module.
- Tests:
  - `tests/server/workflow-runner-start.test.ts` — `startWorkflow` returns immediately, run completes in background.
  - `tests/unit/scan-workflow-scripts.test.ts` — file scanner (good + bad files).
  - `tests/server/routes-workflows.test.ts` — HTTP routes (list, start, list runs, get run).

---

## Task 1: Refactor runner → split execute from kickoff

**Files:** `src/server/workflow-runner.ts`, test `tests/server/workflow-runner-start.test.ts`

- [ ] **Step 1: failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true }) })

const wsPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'wf-start-'))
  const w = join(d, 'ws'); mkdirSync(w, { recursive: true }); dirs.push(d); return { d, w }
}

const waitFor = async (cond: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timeout')
}

describe('startWorkflow', () => {
  test('returns the initial running record immediately; body runs in background', async () => {
    const { d, w } = wsPath()
    const scriptPath = join(w, 'noop.ts')
    writeFileSync(scriptPath, "export const meta = { name: 'n', description: 'd' }\nreturn 1")
    const store = createRuntimeStore({ dataDir: d, agentManager: createAgentManager() })
    try {
      const ws = store.createWorkspace(w, 'WS')
      const initial = await store.startWorkflow({ workspaceId: ws.id, scriptPath, hivePort: '0' })
      expect(initial.status).toBe('running')
      await waitFor(() => store.getWorkflowRun(initial.id)?.status === 'completed')
      const final = store.getWorkflowRun(initial.id)
      expect(final?.status).toBe('completed')
    } finally {
      await store.close()
    }
  })
})
```

- [ ] **Step 2: run → FAIL** (`startWorkflow` not on store; `getWorkflowRun` not on store)

- [ ] **Step 3: refactor runner**

In `workflow-runner.ts`, factor out the body of `runWorkflow` AFTER `createRun` into an internal `executeWorkflow(run, loaded, args, hivePort)` async function. Then:
- `runWorkflow(input)` = load + createRun + await execute + getRun (existing behavior preserved)
- `startWorkflow(input): Promise<WorkflowRunRecord>` = load + createRun, kick off `executeWorkflow(...)` via `queueMicrotask` (or `setImmediate`), return the initial record.

```ts
const startWorkflow = async (input: RunWorkflowInput): Promise<WorkflowRunRecord> => {
  const loaded = await loadWorkflowScriptFile(input.scriptPath)
  const run = workflowRunStore.createRun({
    workspaceId: input.workspaceId,
    scriptPath: input.scriptPath,
    name: loaded.meta.name,
    scriptHash: loaded.scriptHash,
    ...(input.args !== undefined ? { args: input.args } : {}),
  })
  queueMicrotask(() => {
    executeWorkflow(run, loaded, input.args, input.hivePort).catch((error) => {
      console.error('[hive] swallowed:workflow.background', error)
    })
  })
  return run
}
```

Surface both on the returned `WorkflowRunner`.

- [ ] **Step 4: expose on store**

In `runtime-store.ts`:
- Add to the `RuntimeStore` interface: `startWorkflow`, `getWorkflowRun`, `listWorkspaceWorkflowRuns`.
- Implementations:
  - `startWorkflow: (input) => runner.startWorkflow(input)`
  - `getWorkflowRun: (runId) => services.workflowRunStore.getRun(runId)`
  - `listWorkspaceWorkflowRuns: (workspaceId) => services.workflowRunStore.listWorkspaceRuns(workspaceId)`

- [ ] **Step 5: run → PASS.**

- [ ] **Step 6: commit** — `Add startWorkflow + workflow-run accessors on the store`

---

## Task 2: filesystem scanner

**Files:** `src/server/workflow-script-loader.ts`, test `tests/unit/scan-workflow-scripts.test.ts`

- [ ] **Step 1: failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scanWorkflowScripts } from '../../src/server/workflow-script-loader.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wf-scan-')); dirs.push(d); return d }

describe('scanWorkflowScripts', () => {
  test('returns empty when .hive/workflows is absent', async () => {
    const out = await scanWorkflowScripts(tmp())
    expect(out).toEqual([])
  })

  test('returns meta + scriptHash for every .ts and reports per-file errors', async () => {
    const root = tmp()
    const dir = join(root, '.hive/workflows'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ok.ts'), "export const meta = { name: 'ok', description: 'd' }\nreturn 1")
    writeFileSync(join(dir, 'bad.ts'), "return 1") // no meta → loader throws
    const out = await scanWorkflowScripts(root)
    expect(out.find((r) => r.scriptPath.endsWith('ok.ts'))?.meta?.name).toBe('ok')
    expect(out.find((r) => r.scriptPath.endsWith('bad.ts'))?.error).toMatch(/meta/)
  })

  test('skips non-.ts files', async () => {
    const root = tmp()
    const dir = join(root, '.hive/workflows'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.md'), 'not a script')
    const out = await scanWorkflowScripts(root)
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: run → FAIL.**

- [ ] **Step 3: implement**

In `workflow-script-loader.ts`:
```ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface ScannedWorkflow {
  scriptPath: string
  meta?: WorkflowMeta
  scriptHash?: string
  error?: string
}

export const scanWorkflowScripts = async (workspacePath: string): Promise<ScannedWorkflow[]> => {
  const dir = join(workspacePath, '.hive', 'workflows')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const tsFiles = entries.filter((name) => name.endsWith('.ts'))
  const out: ScannedWorkflow[] = []
  for (const name of tsFiles.sort()) {
    const scriptPath = join(dir, name)
    try {
      const loaded = await loadWorkflowScriptFile(scriptPath)
      out.push({ scriptPath, meta: loaded.meta, scriptHash: loaded.scriptHash })
    } catch (error) {
      out.push({ scriptPath, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return out
}
```

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: expose on store**

`runtime-store.ts`:
- Interface: `scanWorkflowScripts: (workspaceId: string) => Promise<ScannedWorkflow[]>`
- Impl: look up the workspace path via `services.workspaceStore.getWorkspaceSnapshot(workspaceId).summary.path`, call `scanWorkflowScripts(path)`.

- [ ] **Step 6: commit** — `Add scanWorkflowScripts and expose it on the store`

---

## Task 3: routes

**Files:** new `src/server/routes-workflows.ts`, modify route aggregator, test `tests/server/routes-workflows.test.ts`

Routes:
- `GET /api/workspaces/:id/workflows` — `{ scripts: ScannedWorkflow[] }`
- `POST /api/workspaces/:id/workflows/runs` — body `{ script_path, args? }` → 202 `{ run }`
- `GET /api/workspaces/:id/workflows/runs` — `{ runs: WorkflowRunRecord[] }`
- `GET /api/workflows/runs/:runId` — `{ run: WorkflowRunRecord }` (404 if absent)

UI cookie auth. Path-pattern matching follows existing routes-workspaces.ts.

- [ ] **Step 1: failing test** — start a workflow via POST, assert 202 + run record.

```ts
// tests/server/routes-workflows.test.ts
// (uses runHiveCommand + getUiCookie + a temp workspace + a tiny noop script)
// 1) POST /api/workspaces/:id/workflows/runs → 202, body.run.status === 'running'
// 2) GET .../runs → contains the new run
// 3) GET /api/workflows/runs/:id → the same run
// 4) GET .../workflows → lists the noop.ts script with meta
```

- [ ] **Step 2: run → FAIL.**

- [ ] **Step 3: implement `routes-workflows.ts`**

Sketch — uses the existing `route()`/`sendJson`/`readJsonBody` helpers and the existing UI-auth pattern:

```ts
import { requireUiAuth } from './ui-auth-middleware.js'   // existing pattern
import { route, sendJson, readJsonBody } from './route-helpers.js'
import { BadRequestError, NotFoundError } from './http-errors.js'

export const workflowRoutes = [
  route('GET', '/api/workspaces/:id/workflows', async ({ params, response, store, request }) => {
    requireUiAuth(request, store)
    const workspaceId = params.id
    sendJson(response, 200, { scripts: await store.scanWorkflowScripts(workspaceId) })
  }),
  route('POST', '/api/workspaces/:id/workflows/runs', async ({ params, request, response, store }) => {
    requireUiAuth(request, store)
    const body = await readJsonBody<{ script_path?: string; args?: unknown }>(request)
    const scriptPath = typeof body.script_path === 'string' ? body.script_path : ''
    if (!scriptPath) throw new BadRequestError('Missing script_path')
    const hivePort = String(request.socket.localPort ?? '')
    const run = await store.startWorkflow({
      workspaceId: params.id,
      scriptPath,
      hivePort,
      ...(body.args !== undefined ? { args: body.args } : {}),
    })
    sendJson(response, 202, { run })
  }),
  route('GET', '/api/workspaces/:id/workflows/runs', ({ params, response, request, store }) => {
    requireUiAuth(request, store)
    sendJson(response, 200, { runs: store.listWorkspaceWorkflowRuns(params.id) })
  }),
  route('GET', '/api/workflows/runs/:runId', ({ params, response, request, store }) => {
    requireUiAuth(request, store)
    const run = store.getWorkflowRun(params.runId)
    if (!run) throw new NotFoundError(`Workflow run not found: ${params.runId}`)
    sendJson(response, 200, { run })
  }),
]
```

Adjust to match the actual route-helper signatures and auth pattern (open the existing `routes-workspaces.ts` to copy exactly).

- [ ] **Step 4: register in the route aggregator** (find where other route modules are combined into the server).

- [ ] **Step 5: run → PASS.**

- [ ] **Step 6: commit** — `Add /api/workspaces/:id/workflows routes + /api/workflows/runs/:runId`

---

## Task 4: gate + push

- [ ] `pnpm check && pnpm test` — biome clean + green
- [ ] `git push private feat/workflow-runtime`

## Self-review

- **Spec coverage:** §3 list workflows → Task 2+3; start run → Task 3 (POST); fetch run → Task 3 (GET); listing → Task 3.
- **Non-blocking start:** `startWorkflow` returns immediately so HTTP responses don't hang. Background errors are logged (`console.error('[hive] swallowed:workflow.background', ...)`) — matches the existing swallow-and-log convention in team-operations.
- **Auth:** UI cookie on every route (workflow management is a UI/internal API, not a CLI-agent surface).
- **Idempotence:** `getWorkflowRun` returns `undefined` for unknown ID → route 404s explicitly.

## Downstream

- **M3:** `workflow()` nesting (parent runner can launch child runs), cron `scheduled_runs` table + scheduler.
- **M4:** UI Workflows tab — list + start + progress tree.
