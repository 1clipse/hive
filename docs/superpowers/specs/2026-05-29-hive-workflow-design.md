# Hive Workflow Runtime — Design Spec

- **Date:** 2026-05-29
- **Branch:** `feat/workflow-runtime`
- **Status:** Design approved in conversation; awaiting spec review before `writing-plans`.
- **Scope directive (from user):** Full goal, **not** an MVP (「不要 mvp，按完整目标实施」).

## 1. Goal

Add a **deterministic multi-agent workflow runtime** to Hive, borrowing Claude Code's Workflow tool design (`agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `workflow()`), but built on Hive's existing primitives: real CLI-agent PTYs, the `team` protocol, the dispatch ledger, and role templates.

A workflow is a TypeScript script in `<workspace>/.hive/workflows/*.ts`. The Hive runtime executes it deterministically: each `agent()` call **spawns an ephemeral worker** (a real CLI agent in a PTY), sends it a task via the existing dispatch path, waits for its `team report`, validates the reported JSON against the call's schema, and returns the parsed object to the script. The script's control flow (loops, conditionals, fan-out) is plain JS, so the orchestration is reproducible — not at the mercy of an LLM's mood.

### 1.1 Differentiator (the reason this is worth building)

CC Workflow's `agent()` is always backed by one model family (the Claude API). Hive's `agent()` is backed by a **real CLI agent**, so a single workflow can **mix CLI backends** — Claude Code for one step, Codex for the next, Gemini/OpenCode for another:

```ts
// .hive/workflows/review.ts
export const meta = { name: 'review-changes', description: 'Multi-CLI review + verify' }

const findings = await parallel([
  () => agent({ cli: 'claude', role: 'reviewer', prompt: 'find correctness bugs', schema: BUGS }),
  () => agent({ cli: 'codex',  role: 'reviewer', prompt: 'find perf issues',      schema: PERF }),
  () => agent({ cli: 'gemini', role: 'reviewer', prompt: 'find security issues',  schema: SEC  }),
])
const verified = await pipeline(findings.flat(),
  (f) => agent({ cli: 'claude', role: 'reviewer', prompt: `verify: ${f.title}`, schema: VERDICT })
)
return verified.filter((v) => v.isReal)
```

No other tool can fan a single deterministic workflow across multiple CLI agent backends. This is the headline feature for README/marketing.

### 1.2 Non-goals (YAGNI)

- No in-browser script editor in early milestones (read-only viewer first; CodeMirror editor is M5).
- No remote/distributed execution — everything runs in the local Hive runtime.
- No visual drag-and-drop workflow builder. Scripts are code.
- No per-step budget enforcement in tokens (Hive doesn't meter tokens). `budget` from CC Workflow is **out of scope**.

## 2. Architecture

### 2.1 Spawn as a shared runtime primitive

The core enabler is **dynamic worker spawn** at the runtime level, shared by two drivers:

```
                ┌────────────────────────────────────┐
                │            Hive runtime             │
                │  spawnWorker(roleTemplate, opts)    │
                │  dismissWorker(workerId)            │
                └───┬──────────────────────────┬──────┘
                    │                          │
        ┌───────────┘                          └──────────────┐
   ┌────┴───────────────┐                  ┌──────────────────┴┐
   │  orchestrator      │                  │ workflow runner    │
   │  (LLM, in a PTY)   │                  │ (deterministic JS) │
   │  team spawn/dismiss│                  │ agent()/parallel() │
   └────────────────────┘                  └────────────────────┘
```

**Decision (full goal): the orchestrator ALSO gets spawn.** Both drivers call the same runtime primitive. The orchestrator gets two new `team` verbs (`team spawn`, `team dismiss`); the workflow runner calls the primitive directly. Rationale: the user explicitly chose the full-goal option ("orch 也能 spawn — 完整目标"). Abuse risk (LLM spawns unboundedly) is bounded by lifecycle rules in §6.3 — **not** by an idle timeout (Hive's design philosophy is "no silent detection / no heartbeat").

> Spec-review checkpoint: this resolves the one architecture question left open when the design session was interrupted. If the reviewer prefers conservative (workflow-runner-only spawn), only §6.3 and §11 change; the rest of the spec stands.

### 2.2 Component inventory

New modules (server):
- `workflow-runner.ts` — executes a transpiled workflow module; owns the run lifecycle.
- `workflow-dsl.ts` — the `agent()/parallel()/pipeline()/phase()/log()/workflow()` host functions injected into the script scope.
- `workflow-script-loader.ts` — reads `.hive/workflows/*.ts`, transpiles with esbuild, computes `script_hash`, evaluates the module.
- `workflow-run-store.ts` — persists `workflow_runs` + step rows; drives the progress tree.
- `workflow-schedule-store.ts` — persists `scheduled_runs`; the cron scanner.
- `routes-workflows.ts` — HTTP: list scripts, start/stop/resume a run, list runs, get run detail.
- `__workflow__` pseudo-agent provisioning (in `workspace-store` hydration).

Reused as-is (do not reinvent): `dispatch-ledger-store`, `role-template-store` / `role-templates`, `runtime-store.startAgent` / `deleteWorker`, `agent-manager` (PTY lifecycle), `team` CLI + `routes-team`, `terminal-stream-hub` (WS), `useWorkspaceWorkers` SWR on the frontend.

New modules (web): `workflow/` dir — `WorkflowsTab.tsx`, `WorkflowRunCard.tsx`, `WorkflowProgressTree.tsx`, `useWorkflowRuns.ts`, plus worker-card source badges.

## 3. The DSL

The script is an ES module. It MUST export `meta` (pure literal: `{ name, description, cron? }`) and uses a top-level-await body. Host functions injected into scope:

| Function | Semantics |
|---|---|
| `agent(opts)` | Spawn one ephemeral worker, dispatch `opts.prompt`, await its `team report`, validate against `opts.schema` (if given), return parsed object (or raw report text if no schema). Worker is dismissed when the call resolves. |
| `parallel(thunks)` | Run thunks concurrently (barrier). A thunk that throws → `null` in the result array; the call never rejects. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently (no barrier between stages). Stage throw → that item drops to `null`. |
| `phase(title)` | Start a progress-tree group; subsequent `agent()` calls attach under it. |
| `log(msg)` | Emit a narrator line to the run's UI. |
| `workflow(nameOrPath, args?)` | Run another workflow inline as a sub-step (one level of nesting). |
| `args` | The value passed when the run was started (HTTP body / cron config). |

### 3.1 `agent(opts)` options

```ts
interface AgentOpts {
  prompt: string
  role?: WorkerRole            // role template → system prompt + tool whitelist (default 'coder')
  cli?: 'claude' | 'codex' | 'opencode' | 'gemini'   // backend; maps to a command preset
  schema?: JSONSchema          // when present, the worker MUST report matching JSON
  name?: string                // display name; default derived from phase + index
  label?: string               // progress-tree label override
}
```

- `cli` maps to the existing `BUILTIN_COMMAND_PRESETS` via `resolveCommandPresetLaunchConfig` (gap #5 — already exists, just reference it). Default = workspace default / `claude`.
- Concurrency cap: at most `min(8, cores-1)` live workflow-spawned workers per workspace; excess `agent()` calls queue. (Configurable later; hard backstop = workflow_runs aborts past 200 total spawns.)

### 3.2 Schema-enforced structured output

When `schema` is set, the dispatch payload appends: *"Return ONLY a fenced ```json block matching this JSON Schema: <schema>. No prose."* On `team report`, the runner extracts the JSON, validates (validator choice: §17 Q2 — recommended a minimal in-repo JSON-Schema-subset validator, zero new dep), and on mismatch **reissues** the dispatch to the same worker up to 2 times with the validation error, then fails the step (→ `null`, like CC Workflow). No silent fallback.

## 4. Script execution model

- **Location:** `<workspace>/.hive/workflows/<name>.ts`. Discoverable via `routes-workflows` list.
- **Transpile:** `esbuild.transform(source, { loader: 'ts', format: 'esm' })` in-process. **esbuild moves to `dependencies`** (B1). `tsx` is devDep-only and not usable at runtime, so it is not an option for the shipped package.
- **Evaluation:** the loader extracts the `meta` export statically (parse the `export const meta = {...}` literal without running the body), then wraps the remaining body in an async function whose parameters are the DSL host functions + `args`, and invokes it. (Top-level `await` and a trailing `return` in the body are therefore valid — they execute inside the wrapper, same contract as CC Workflow.) No `node:vm` sandbox in early milestones (scripts are user-authored, same trust level as the agents they spawn); document this. A `node:vm` isolate is a later hardening option (§17 Q3).
- **`script_hash`:** `sha256(esbuild_output_bytes)` (gap #2). Scoped to `(workspace_id, script_relative_path)`. Comment-only edits that don't change transpiled output do not invalidate. Used for the run journal / resume cache key. No active eviction (same as the dispatch ledger).

## 5. Stdin write serialization (M0 — prerequisite)

**Problem (B2, blocking, also a latent bug today):** `agent-stdin-dispatcher.ts` `writeToActiveAgentRun` (line 84) calls `createPostStartInputWriter(...)` / `agentManager.writeInput(...)` with no serialization. Two writers to the same worker — e.g. the UI button + the orchestrator, or the orchestrator + the workflow runner — can both observe the `❯` prompt-ready state and concurrently write bracketed-paste payloads, producing interleaved/corrupted stdin. The workflow runner makes this routine instead of rare.

**Fix:** a per-`agentId` promise chain in `agent-stdin-dispatcher.ts`. Every `writeSendPrompt / writeReportPrompt / writeStatusPrompt / writeUserInputPrompt / writeCancelPrompt` for a given agent enqueues onto that agent's chain so writes to one worker are strictly serial. Writes to different agents stay concurrent. This ships **independently** (M0) and fixes the existing UI-vs-orch race regardless of workflows.

## 6. Spawn primitive & ephemeral workers

### 6.1 Atomic spawn (gap #1)

New `runtime-store.addWorkerWithLaunch(workspaceId, workerInput, launchConfig)` wraps the `addWorker` + `configureAgentLaunch` pair in one `runDataMutation` transaction, so a partial spawn can't leave a worker row with no launch config. The workflow runner and `team spawn` both use it.

### 6.2 Ephemeral flag (migration v19)

`workers.ephemeral INTEGER NOT NULL DEFAULT 0` and `workers.spawned_by TEXT` (`'workflow' | 'orchestrator' | NULL`). Ephemeral workers are excluded from the persisted "team roster" UX and are eligible for cascade cleanup.

### 6.3 Lifecycle / cleanup rules

| Source | Who stops it | Rule |
|---|---|---|
| User "Add Worker" (UI) | User | Unchanged; `ephemeral=0`. |
| Workflow `agent()` | Runner | Dismissed when the `agent()` call resolves; on script exit/throw all the run's workers are dismissed. |
| Orchestrator `team spawn` | Cascade + user | `ephemeral=1, spawned_by='orchestrator'`. Cascade-stop when the orchestrator's own PTY exits; orch can `team dismiss`; user can dismiss in UI. **No idle timeout.** |

**Boot cleanup (gap #7):** on runtime start, delete orphan ephemeral workers (their spawner is gone). A workflow run interrupted by a runtime restart is marked `interrupted` and is **not** auto-resumed (consistent with existing crash-recovery philosophy); the UI offers a Resume button.

## 7. Dispatch identity (B3)

The workflow runner is not a PTY and has no `workers` row, but `dispatches.from_agent_id` references an agent and the orchestrator-side formatter renders `[Hive 系统消息：来自 @<name>]` (agent-stdin-dispatcher.ts:22), which needs a name.

**Fix:** auto-provision one `__workflow__` pseudo-agent row per workspace (role `'workflow'`, no PTY, hidden from `listWorkers` UI). Dispatches originated by a workflow set `from_agent_id = '<workspaceId>:__workflow__'`, so the FK is valid and the from-name renders as e.g. "workflow run #<run_id>". `dispatches.from_agent_id` is already nullable, but the pseudo-agent keeps name resolution and any future FK constraint clean.

## 8. Awaiting dispatch completion (gap #6)

Today `team report` is fire-and-forget into the orchestrator's stdin. The workflow runner must `await` a specific dispatch's completion. Add:

- A WS/event channel `workflow:dispatch_observed` emitted when a dispatch flips to `reported`/`cancelled`; the runner subscribes in-process (no socket needed — it's the same process; use the existing event bus).
- New CLI verb `team wait --dispatch <id> --timeout <ms>` for symmetry / external scripting (the in-process runner uses the event bus directly, not the CLI).

The runner resolves an `agent()` step when its dispatch reaches `reported` (then validates), or fails it on `cancelled` / timeout.

## 9. Data model & migrations

All additive, sequential from the current head (**v18 → v19/v20/v21**). Pattern: inline in `sqlite-schema.ts`, guarded by `schema_version`.

- **v19:** `ALTER TABLE workers ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0`; `ADD COLUMN spawned_by TEXT`; `ALTER TABLE dispatches ADD COLUMN workflow_run_id TEXT`; `ADD COLUMN step_index INTEGER`; `CREATE INDEX idx_dispatches_workflow ON dispatches(workflow_run_id, step_index)` (gap #4).
- **v20:** `CREATE TABLE workflow_runs (id, workspace_id, script_path, script_hash, name, status TEXT /* running|completed|failed|interrupted|stopped */, phase TEXT, args TEXT, started_at, finished_at, error, created_at)` + index on `(workspace_id, created_at)`.
- **v21:** `CREATE TABLE scheduled_runs (id, workspace_id, script_path, cron TEXT, enabled INTEGER, next_fire_at INTEGER, last_fired_at INTEGER, created_at)` + index on `next_fire_at` (gap #3).

## 10. CLI verbs (`team`)

```
team spawn <role> [--name <n>] [--cli <claude|codex|opencode|gemini>]   → prints worker_id; immediately dispatchable
team dismiss <worker-name>                                              → explicit stop + cleanup
team wait --dispatch <id> [--timeout <ms>]                              → block until reported/cancelled (for external scripting)
```

These extend `src/cli/team.ts` and `routes-team.ts`, reusing `team-authz` (the orchestrator is authorized for `spawn`/`dismiss`; workers are not).

## 11. Cron / scheduling (M3)

`meta.cron` (a 5-field cron string) registers a `scheduled_runs` row. A boot-time scanner + interval timer fires due runs. **Misfire policy:** skip if the scheduled time is older than 60 min; if multiple fires were missed during downtime, fire **once**, not catch-up-all. Cron survives runtime restart via the table (re-scanned on boot).

## 12. UI

A new **Workflows** tab, peer to Orchestrator / Workers / Tasks:

- **Run card:** name, current phase, a CC-style progress tree (`phase` groups → `agent()` leaves), `[Stop]` / `[View Script]` / `[Resume]` (interrupted). Each leaf links to that spawned worker's terminal.
- **Worker-card source badges:** `[workflow]` / `[orch]` badge + CLI icon (CC/Codex/Gemini/OpenCode) top-right — **mix-CLI visible at a glance** (the marketing screenshot).
- **Spawn/dismiss animation:** add `worker_spawned` / `worker_dismissed` events; frontend `setWorkersByWorkspaceId` fades cards in/out.
- **Crowding defense (decision = collapse):** workflow-spawned workers do **not** enter the main Workers panel; they live under their run card. They surface to the main panel only on **Promote**.
- **Ephemeral "regret window":** a finished ephemeral worker flips to `stopped` + semi-transparent with `Promote to persistent` / `Dismiss` buttons; auto-dismissed after 5 min of no action. Promote writes it to the persistent roster (`ephemeral=0`, badge removed).

## 13. Error handling

- **Schema mismatch:** reissue ≤2×, then step → `null` (§3.2).
- **Script transpile error:** run fails fast with the esbuild diagnostic surfaced in the run card; nothing spawned.
- **Script runtime throw:** run → `failed`; all the run's ephemeral workers dismissed; error stored on `workflow_runs.error`.
- **Runtime restart mid-run:** run → `interrupted`; no auto-resume; orphan ephemeral workers cleaned on boot; UI Resume re-runs from the top (cache by `script_hash` may short-circuit completed steps in a later milestone — not required for first ship).
- **No unhandled rejections:** every fire-and-forget path in the runner is `.catch()`-guarded (consistent with the broader crash-hardening direction).

## 14. Testing strategy (per AGENTS.md)

- **Integration tests (`tests/server/*`, `tests/cli/*`): NO mocking of PTY / node-pty.** A workflow integration test spawns real (dummy CLI) workers via the runner, exercises `agent()`/`parallel()`/`pipeline()` end-to-end against a real dispatch round-trip, and asserts on real `team report` flow. Dummy CLI via `HIVE_*` env command injection (e.g. a `bash -c` echo+report stub), same pattern existing autostart tests use.
- **Unit tests (`tests/unit/*`):** pure logic only — DSL scheduling (pipeline ordering, parallel barrier, null-on-throw), `script_hash` stability, schema validation + reissue counting, cron misfire policy, the per-agent write-queue ordering.
- **Every assertion must fail if the product code is written backwards** (AGENTS.md §3). No `not.toThrow()`-only tests, no asserting injected mock calls.

## 15. Milestones (full goal)

```
M0  Per-agent stdin write queue                  (B2; ships standalone, fixes today's UI-vs-orch race)
M1  Spawn primitive + ephemeral flag (v19) + addWorkerWithLaunch + __workflow__ pseudo-agent (B3)
    + team spawn/dismiss verbs + cascade/boot cleanup + worker_spawned/dismissed events + UI badges
M2  Workflow runtime: loader (esbuild→deps, script_hash) + DSL (agent/parallel/pipeline/phase/log)
    + workflow_runs (v20) + dispatch await (workflow:dispatch_observed) + schema validate/reissue
    + Workflows tab w/ progress tree + run card + View Script (read-only)
M3  workflow() nesting + meta.cron scheduling + scheduled_runs (v21) + misfire policy
M4  Ephemeral 5-min Promote window + crowding=collapse polish + cascade-dismiss UX + Resume button
M5  Built-in template library + in-browser CodeMirror script editor
M6  team wait CLI verb + docs/README mix-CLI showcase + marketing screenshot flow
```

Each milestone ships independently, has acceptance criteria written in its plan, and ends with `superpowers:requesting-code-review`.

## 16. Adopted review resolutions (traceability)

- **B1** esbuild → `dependencies`; `script_hash` = sha256(transpiled output). (§4)
- **B2** per-agent stdin write queue as **M0**. (§5)
- **B3** `__workflow__` pseudo-agent for dispatch identity. (§7)
- **Gaps 1–7** → §6.1, §4, §11, §9 (v19 index), §3.1 (cli preset reuse), §8, §6.3. All folded in.

## 17. Open questions for spec review

1. Orch-spawn = full goal (adopted). Veto → conservative (runner-only spawn)?
2. Schema validator: add `ajv` (heavier, standard) vs. a minimal in-repo JSON-Schema subset validator (zero new dep)? Recommendation: minimal validator for the subset CC Workflow uses (object/array/string/number/enum/required), escalate to ajv only if needed.
3. `node:vm` isolation for scripts — defer to post-M6 hardening, or require in M2? Recommendation: defer (scripts are same-trust as spawned agents).
