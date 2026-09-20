# M2 Slice C — Workflow Runner + DSL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Make workflows actually run end-to-end. `agent(prompt, opts)` = spawn ephemeral worker → dispatch (as `__workflow__`, with `workflow_run_id`/`step_index`) → await the worker's `team report` → return the result → dismiss the worker. Plus `parallel/pipeline/phase/log`. Drives `workflow_runs` lifecycle (running → completed/failed).

**Architecture:** A new `workflow-dispatch-awaiter` is a `Map<dispatchId, {resolve, reject, timer}>`. `team-operations.reportTask` already does `markDispatchReportedByWorker` → the change is: when the dispatch's `fromAgentId === workflowAgentId`, call `awaiter.notifyReport(dispatchId, {text, artifacts})` and **skip** the existing `writeReportPrompt` (which hardcodes orchestrator PTY). The runner is built on top of the existing store; the script-loader (M2-B) gives it a callable async function; the DSL is just closures bound per run.

**Tech Stack:** TypeScript, Vitest, Biome. No new deps.

**Spec references:** §3 (DSL), §5–6 (runner + cleanup), §13 (interrupted on restart already done in M2-A).

## Background facts (verified)

- `getWorkflowAgentId(workspaceId)` → `${workspaceId}:__workflow__` (M1-B).
- Workflow pseudo-agent is in `getWorkspaceSnapshot.agents` (workspace-store.ts:92) — `getAgent`/`hasAgent` resolve it.
- `dispatches` table has `workflow_run_id`/`step_index` (M1-B), but `DispatchTaskInput` (team-operations.ts:76) doesn't expose them yet — must plumb.
- `team-operations.reportTask` (lines 286–337) always calls `writeReportPrompt` which writes to `${workspaceId}:orchestrator`. For workflow dispatches the routing must change.
- Store exposes everything needed: `addWorkerWithLaunch`, `startAgent`, `dispatchTaskByWorkerName`, `deleteWorker`. The runner is pure JS orchestration.

## File structure

- New: `src/server/workflow-dispatch-awaiter.ts`
- New: `src/server/workflow-runner.ts`
- Modify: `src/server/team-operations.ts` — extend `DispatchTaskInput` with `workflowRunId`/`stepIndex`; plumb to `createDispatch`; route reportTask via fromAgentId
- Modify: `src/server/runtime-store-helpers.ts` — construct awaiter, pass to teamOps + runner, return both
- Modify: `src/server/runtime-store.ts` — expose `runWorkflow(input)` on the public store interface
- Tests: `tests/unit/workflow-dispatch-awaiter.test.ts`, `tests/server/workflow-runner.test.ts`

## Public surface

```ts
// awaiter
interface ReportPayload { text: string; artifacts: string[]; status?: string }
interface WorkflowDispatchAwaiter {
  awaitReport(dispatchId: string, timeoutMs?: number): Promise<ReportPayload>
  notifyReport(dispatchId: string, payload: ReportPayload): void
  notifyCancel(dispatchId: string, reason: string): void
  cancelAll(reason: string): void  // on close, fail every pending
}

// runner
interface RunWorkflowInput {
  workspaceId: string
  scriptPath: string  // absolute
  args?: unknown
  hivePort: string
}
interface WorkflowRunner {
  runWorkflow(input: RunWorkflowInput): Promise<WorkflowRunRecord>
}
```

---

## Task 1: extend `DispatchTaskInput` + plumb to `createDispatch`

**Files:** `src/server/team-operations.ts`; existing dispatch-ledger tests should still pass.

- [ ] **Step 1: failing test** — `tests/server/workflow-dispatch-plumbing.test.ts`

```ts
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getWorkflowAgentId } from '../../src/server/workspace-store-support.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {force:true, recursive:true}) })
const wsPath = () => {
  const d = mkdtempSync(join(tmpdir(),'wf-plumb-'))
  const w = join(d,'ws'); mkdirSync(w,{recursive:true}); dirs.push(d); return {d,w}
}

describe('dispatchTask plumbs workflow_run_id + step_index', () => {
  test('persists workflowRunId/stepIndex onto the dispatch row', async () => {
    const {d, w} = wsPath()
    const store = createRuntimeStore({dataDir:d})
    try {
      const ws = store.createWorkspace(w, 'WS')
      const worker = store.addWorker(ws.id, {name:'alice', role:'coder'})
      const dispatch = await store.dispatchTaskByWorkerName(ws.id, 'alice', 'hi', {
        fromAgentId: getWorkflowAgentId(ws.id),
        // NEW fields:
        workflowRunId: 'run-1',
        stepIndex: 7,
      } as any)
      expect(dispatch.workflowRunId).toBe('run-1')
      expect(dispatch.stepIndex).toBe(7)
    } finally { await store.close() }
  })
})
```

- [ ] **Step 2: run → FAIL** (TS-level: unknown property; or runtime: not persisted)

- [ ] **Step 3: extend `DispatchTaskInput`** in `team-operations.ts:76`

```ts
export interface DispatchTaskInput {
  fromAgentId?: string
  hivePort?: string
  workflowRunId?: string
  stepIndex?: number
}
```

- [ ] **Step 4: plumb in `dispatchTask`** (team-operations.ts ~155)

Right after building `dispatchInput`, add:
```ts
if (input.workflowRunId !== undefined) dispatchInput.workflowRunId = input.workflowRunId
if (input.stepIndex !== undefined) dispatchInput.stepIndex = input.stepIndex
```
Widen the local `dispatchInput` type to include these optional fields.

Also: `dispatchInput` is fed to `createDispatch` whose `CreateDispatchInput` already accepts `workflowRunId`/`stepIndex` (dispatch-ledger-store.ts:45–48).

- [ ] **Step 5: run → PASS.** All existing dispatch tests should still pass.

- [ ] **Step 6: commit** — `Plumb workflow_run_id and step_index through dispatchTask`

---

## Task 2: dispatch-await registry

**Files:** new `src/server/workflow-dispatch-awaiter.ts`, test `tests/unit/workflow-dispatch-awaiter.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, expect, test, vi } from 'vitest'
import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'

describe('workflow dispatch awaiter', () => {
  test('resolves the awaiter when notifyReport arrives', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d1', 5000)
    a.notifyReport('d1', {text:'ok', artifacts:[]})
    await expect(p).resolves.toEqual({text:'ok', artifacts:[]})
  })

  test('rejects when notifyCancel arrives', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d2', 5000)
    a.notifyCancel('d2', 'aborted')
    await expect(p).rejects.toThrow(/aborted/)
  })

  test('rejects on timeout', async () => {
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d3', 10)
    vi.advanceTimersByTime(50)
    await expect(p).rejects.toThrow(/timeout/i)
    vi.useRealTimers()
  })

  test('notifyReport for unknown dispatchId is a no-op (race-safe)', () => {
    const a = createWorkflowDispatchAwaiter()
    expect(() => a.notifyReport('unknown', {text:'', artifacts:[]})).not.toThrow()
  })

  test('cancelAll rejects every pending', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p1 = a.awaitReport('a', 5000)
    const p2 = a.awaitReport('b', 5000)
    a.cancelAll('shutdown')
    await expect(p1).rejects.toThrow(/shutdown/)
    await expect(p2).rejects.toThrow(/shutdown/)
  })
})
```

- [ ] **Step 2: run → FAIL** (module not found)

- [ ] **Step 3: implement**

```ts
export interface ReportPayload {
  text: string
  artifacts: string[]
  status?: string
}

interface Pending {
  resolve: (p: ReportPayload) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export interface WorkflowDispatchAwaiter {
  awaitReport(dispatchId: string, timeoutMs?: number): Promise<ReportPayload>
  notifyReport(dispatchId: string, payload: ReportPayload): void
  notifyCancel(dispatchId: string, reason: string): void
  cancelAll(reason: string): void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes; workflows often run long

export const createWorkflowDispatchAwaiter = (): WorkflowDispatchAwaiter => {
  const pending = new Map<string, Pending>()

  const clear = (id: string) => {
    const entry = pending.get(id)
    if (entry) { clearTimeout(entry.timer); pending.delete(id) }
    return entry
  }

  return {
    awaitReport(dispatchId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<ReportPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(dispatchId)
          reject(new Error(`workflow dispatch ${dispatchId} timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(dispatchId, { resolve, reject, timer })
      })
    },
    notifyReport(dispatchId, payload) {
      const entry = clear(dispatchId)
      entry?.resolve(payload)
    },
    notifyCancel(dispatchId, reason) {
      const entry = clear(dispatchId)
      entry?.reject(new Error(`workflow dispatch ${dispatchId} cancelled: ${reason}`))
    },
    cancelAll(reason) {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`workflow dispatch ${id} cancelled: ${reason}`))
      }
      pending.clear()
    },
  }
}
```

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: commit** — `Add workflow-dispatch-awaiter (Promise registry for runner→worker round-trips)`

---

## Task 3: route reportTask via dispatch.fromAgentId

**Files:** `src/server/team-operations.ts`, `src/server/runtime-store-helpers.ts`

Pass the awaiter into `createTeamOperations` and use it in `reportTask`:

- [ ] **Step 1: failing test** — `tests/server/workflow-report-routing.test.ts`

```ts
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { getWorkflowAgentId } from '../../src/server/workspace-store-support.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {force:true, recursive:true}) })
const wsPath = () => {
  const d = mkdtempSync(join(tmpdir(),'wf-route-'))
  const w = join(d,'ws'); mkdirSync(w,{recursive:true}); dirs.push(d); return {d,w}
}

describe('reportTask routes via dispatch.fromAgentId', () => {
  test('workflow-dispatched reports resolve the awaiter (no PTY forward)', async () => {
    const {d, w} = wsPath()
    const store = createRuntimeStore({dataDir:d, agentManager:createAgentManager()})
    try {
      const ws = store.createWorkspace(w, 'WS')
      const worker = store.addWorkerWithLaunch(
        ws.id,
        {name:'alice', role:'coder', ephemeral:true, spawnedBy:'workflow'},
        {command:'/bin/bash', args:['-lc','sleep 60']}
      )
      // No orchestrator PTY started — proves the route does NOT hit it.
      await store.startAgent(ws.id, worker.id, {hivePort:'0'})

      const dispatch = await store.dispatchTaskByWorkerName(ws.id, 'alice', 'hi', {
        fromAgentId: getWorkflowAgentId(ws.id),
      })

      // Set up the awaiter side BEFORE the report comes in.
      const awaiter = store.getWorkflowDispatchAwaiter()
      const p = awaiter.awaitReport(dispatch.id, 3000)

      // The worker reports via the same code path the HTTP route uses
      const r = store.reportTask(ws.id, worker.id, {text:'done', dispatchId:dispatch.id})
      expect(r.forwarded).toBe(true)        // resolved-via-awaiter still counts as "forwarded"
      expect(r.forwardError).toBeNull()
      await expect(p).resolves.toMatchObject({text:'done'})
    } finally { await store.close() }
  })
})
```

- [ ] **Step 2: run → FAIL** (no `getWorkflowDispatchAwaiter`; report routes to orchestrator).

- [ ] **Step 3: wire awaiter**

In `runtime-store-helpers.ts`:
- import `createWorkflowDispatchAwaiter` + `getWorkflowAgentId`
- `const workflowDispatchAwaiter = createWorkflowDispatchAwaiter()`
- pass `workflowDispatchAwaiter` into `createTeamOperations({...})`
- add it to `RuntimeStoreServices` + the returned object
- in `close()`, call `workflowDispatchAwaiter.cancelAll('runtime closing')` before existing teardown

In `team-operations.ts`:
- accept `workflowDispatchAwaiter` in `createTeamOperations` opts; import `getWorkflowAgentId`
- in `reportTask`, after `markDispatchReportedByWorker`, before the existing forward block:

```ts
const isWorkflowDispatch = dispatch.fromAgentId === getWorkflowAgentId(workspaceId)
if (isWorkflowDispatch) {
  try {
    workflowDispatchAwaiter.notifyReport(dispatch.id, { text, artifacts, ...(status ? {status} : {}) })
    return { dispatch, forwardError: null, forwarded: true }
  } catch (error) {
    return { dispatch, forwardError: reportForwardErrorMessage(error), forwarded: false }
  }
}
// (existing orchestrator-forward block runs only for non-workflow dispatches)
```

In `runtime-store.ts`:
- add `getWorkflowDispatchAwaiter` to public interface returning `services.workflowDispatchAwaiter`

- [ ] **Step 4: run → PASS.** All other reportTask tests must remain green (the change is purely additive — non-workflow dispatches stay on the orchestrator-forward path).

- [ ] **Step 5: commit** — `Route worker reports to the workflow awaiter when the dispatch source is __workflow__`

---

## Task 4: the runner + DSL

**Files:** new `src/server/workflow-runner.ts`, modify `runtime-store-helpers.ts` (construct it), `runtime-store.ts` (expose `runWorkflow`), test `tests/server/workflow-runner.test.ts`.

The runner doesn't need its own awaiter — it uses the one wired into team-operations. The runner needs: store handle (subset), workflowRunStore, awaiter.

- [ ] **Step 1: failing integration test**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {force:true, recursive:true}) })
const wsPath = () => {
  const d = mkdtempSync(join(tmpdir(),'wf-runner-'))
  const w = join(d,'ws'); mkdirSync(w,{recursive:true}); dirs.push(d); return {d,w}
}

describe('workflow runner — single agent() call', () => {
  test('spawns ephemeral worker, awaits report, returns result, dismisses worker', async () => {
    const {d, w} = wsPath()
    const scriptPath = join(w, 'echo.ts')
    writeFileSync(scriptPath, `
export const meta = { name: 'echo', description: 'one agent call' }
const result = await agent('say hello')
return result
    `.trim())

    const store = createRuntimeStore({dataDir:d, agentManager:createAgentManager()})
    try {
      const ws = store.createWorkspace(w, 'WS')

      // Simulate the worker reporting back. The runner is async; we wait for
      // a dispatch to appear, then post a report into it.
      const fakeWorker = (async () => {
        for (let i=0; i<200; i++) {
          await new Promise(r=>setTimeout(r, 20))
          const open = store.listDispatches(ws.id, {status:'submitted'})
          if (open.length > 0) {
            const d0 = open[0]
            store.reportTask(ws.id, d0.toAgentId, {text:'hello back', dispatchId:d0.id})
            return
          }
        }
        throw new Error('no dispatch appeared')
      })()

      const run = await store.runWorkflow({
        workspaceId: ws.id, scriptPath, hivePort: '0',
      })
      await fakeWorker
      expect(run.status).toBe('completed')
      expect(run.error).toBeNull()
      // The ephemeral worker is gone (dismissed after the call).
      expect(store.listWorkers(ws.id).length).toBe(0)
    } finally { await store.close() }
  })
})
```

> Implementer note: the worker is spawned with whatever launch config the runner picks. Default `{command:'/bin/bash', args:['-lc','sleep 60']}` makes a real (passive) PTY; the test does NOT drive its stdin/stdout. The dispatch-await round-trip is exercised by calling `store.reportTask` directly — exactly what the HTTP route does. This is NOT a PTY mock; the PTY is real, we just don't simulate the CLI agent.

- [ ] **Step 2: run → FAIL.**

- [ ] **Step 3: implement `workflow-runner.ts`**

Sketch (keep it small — about 120 LOC):

```ts
import type { ReportPayload, WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'
import type { WorkflowRunRecord } from './workflow-run-store.js'
import { loadWorkflowScriptFile } from './workflow-script-loader.js'
import { getWorkflowAgentId } from './workspace-store-support.js'
import type { WorkerRole } from '../shared/types.js'

interface RunnerStorePort {
  addWorkerWithLaunch(ws:string, w:{name:string,role:WorkerRole,ephemeral:true,spawnedBy:'workflow'},
    launch:{command:string,args:string[]}): {id:string,name:string}
  startAgent(ws:string, agentId:string, input:{hivePort:string}): Promise<unknown>
  dispatchTaskByWorkerName(ws:string, name:string, text:string, input:{
    fromAgentId:string, hivePort:string, workflowRunId:string, stepIndex:number
  }): Promise<{id:string}>
  deleteWorker(ws:string, workerId:string): void
}

interface WorkflowRunStorePort {
  createRun(input:{workspaceId:string,scriptPath:string,name:string,scriptHash?:string,args?:unknown}):WorkflowRunRecord
  updateRun(id:string, input:{status?:string,phase?:string,finishedAt?:number,error?:string}):void
  getRun(id:string): WorkflowRunRecord | undefined
}

export interface RunWorkflowInput {
  workspaceId: string
  scriptPath: string
  hivePort: string
  args?: unknown
}

interface AgentOpts {
  label?: string
  agentType?: WorkerRole
  cli?: string
  timeoutMs?: number
}

export const createWorkflowRunner = (deps: {
  store: RunnerStorePort
  workflowRunStore: WorkflowRunStorePort
  awaiter: WorkflowDispatchAwaiter
}) => {
  const { store, workflowRunStore, awaiter } = deps

  const runWorkflow = async ({workspaceId, scriptPath, hivePort, args}: RunWorkflowInput) => {
    const loaded = await loadWorkflowScriptFile(scriptPath)
    const run = workflowRunStore.createRun({
      workspaceId, scriptPath, name: loaded.meta.name,
      scriptHash: loaded.scriptHash, args,
    })
    const workflowAgentId = getWorkflowAgentId(workspaceId)
    let stepIndex = 0
    const spawnedThisRun: string[] = []   // workerIds we created → must dismiss in finally

    const agent = async (prompt: string, opts: AgentOpts = {}): Promise<string> => {
      const myStep = ++stepIndex
      const role: WorkerRole = opts.agentType ?? 'coder'
      const name = opts.label ?? `${role}-${myStep}-${Math.random().toString(36).slice(2,6)}`
      const cli = opts.cli ?? 'claude'
      const worker = store.addWorkerWithLaunch(
        workspaceId,
        { name, role, ephemeral: true, spawnedBy: 'workflow' },
        { command: cli, args: [] }
      )
      spawnedThisRun.push(worker.id)
      try {
        await store.startAgent(workspaceId, worker.id, {hivePort})
        const dispatch = await store.dispatchTaskByWorkerName(workspaceId, name, prompt, {
          fromAgentId: workflowAgentId,
          hivePort,
          workflowRunId: run.id,
          stepIndex: myStep,
        })
        const report = await awaiter.awaitReport(dispatch.id, opts.timeoutMs)
        return report.text
      } finally {
        // Dismiss after each agent() call — they're single-shot.
        try { store.deleteWorker(workspaceId, worker.id) } catch {/* idempotent */}
        const idx = spawnedThisRun.indexOf(worker.id)
        if (idx !== -1) spawnedThisRun.splice(idx, 1)
      }
    }

    const parallel = <T>(thunks: Array<() => Promise<T>>) =>
      Promise.all(thunks.map(t => t().catch(() => null)))

    const pipeline = async <T>(items: T[], ...stages: Array<(prev:any, item:T, idx:number)=>any>) =>
      Promise.all(items.map((item, idx) => {
        let chain: Promise<any> = Promise.resolve(item)
        for (const stage of stages) chain = chain.then(prev => stage(prev, item, idx))
        return chain.catch(() => null)
      }))

    const phase = (title: string) => workflowRunStore.updateRun(run.id, {phase: title})
    const log = (message: string) => console.log(`[workflow ${loaded.meta.name}] ${message}`)
    const workflow = async (): Promise<never> => {
      throw new Error('workflow() nesting is not yet implemented (M3)')
    }

    try {
      const fn = new Function(`${loaded.compiledFunctionSource}; return __wf`)() as (...a:unknown[])=>Promise<unknown>
      await fn(agent, parallel, pipeline, phase, log, workflow, args)
      workflowRunStore.updateRun(run.id, {status:'completed', finishedAt: Date.now()})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      workflowRunStore.updateRun(run.id, {status:'failed', finishedAt: Date.now(), error: message})
    } finally {
      // Belt-and-suspenders: dismiss any still-living children. Should always be empty.
      for (const wid of spawnedThisRun) {
        try { store.deleteWorker(workspaceId, wid) } catch {/* swallow */}
      }
    }
    return workflowRunStore.getRun(run.id)!
  }

  return { runWorkflow }
}
```

In `runtime-store-helpers.ts`:
- construct: `const workflowRunner = createWorkflowRunner({store: { addWorkerWithLaunch, startAgent, dispatchTaskByWorkerName, deleteWorker }, workflowRunStore, awaiter: workflowDispatchAwaiter })`
- store the runner in the services bag

In `runtime-store.ts`:
- Add `runWorkflow: (input:RunWorkflowInput) => Promise<WorkflowRunRecord>` to the public interface
- Implementation: delegate to `services.workflowRunner.runWorkflow(input)`

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: commit** — `Add workflow-runner with agent/parallel/pipeline/phase/log DSL`

---

## Task 5: gate + push

- [ ] `pnpm check && pnpm test` (full suite green; biome clean)
- [ ] `git push private feat/workflow-runtime`

## Self-review

- **Spec coverage:**
  - §3 DSL (agent/parallel/pipeline/phase/log; workflow stubbed) → Task 4
  - §5 agent() = spawn → dispatch → await → dismiss → result → Task 4
  - §6 single-shot ephemeral workers → Task 4 (try/finally dismiss)
  - §6.3 cascade-on-orchestrator-exit untouched (the runner dismisses its OWN children; if the runtime crashes, M1-D's boot cleanup catches them as orphans — `spawnedBy:'workflow'` ephemeral workers also covered by `cleanupOrphanEphemeralWorkers`)
  - Dispatch-await with no PTY for `__workflow__` → Task 3
- **Risk:** the new `if (isWorkflowDispatch)` branch in `reportTask` MUST run after `markDispatchReportedByWorker` so the ledger reflects the report regardless of routing. Verified in the test.
- **Timeouts:** default 10 min per `agent()` call; configurable via `opts.timeoutMs`. On timeout the awaiter rejects → agent() throws → workflow_runs.status = 'failed'. The worker is still dismissed via the try/finally.
- **Cleanup ordering at shutdown:** `runtime-store.close()` must call `awaiter.cancelAll()` BEFORE `agentRuntime.close()` so in-flight `awaitReport` Promises reject before their workers vanish. Add to the existing close path in `runtime-store-helpers.ts`.

## Downstream

- **M2-D:** `routes-workflows.ts` (list workflows + start/stop/list runs)
- **M3:** `workflow()` nesting (recursive runner invocation, child tokens count toward parent) + cron `scheduled_runs`
- **M4:** UI Workflows tab — file list, run cards, progress tree, ephemeral badge
