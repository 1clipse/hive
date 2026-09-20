# M1 Slice C — `team spawn` / `team dismiss` Verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the orchestrator two new `team` verbs — `team spawn <role> [--name <n>] [--cli <preset>]` (create an ephemeral worker) and `team dismiss <name>` (stop + remove it) — wired through routes + authz, using the M1-A atomic spawn primitive.

**Architecture:** New `POST /api/team/spawn` and `POST /api/team/dismiss` routes, authorized for the orchestrator only (extend `TeamCommand` + `commandAllowedForRole`). `spawn` resolves a launch config from the `--cli` command preset (default = workspace default) and calls `store.addWorkerWithLaunch(ws, { name, role, ephemeral: true, spawnedBy: 'orchestrator' }, launchConfig)` — the worker is created `stopped`; the orchestrator's subsequent `team send` auto-wakes the PTY (existing `ensureWorkerRun`), so spawn does not start a PTY itself. `dismiss` resolves the worker by name and calls `store.deleteWorker`. The CLI verbs mirror the existing `send` command shape.

**Tech Stack:** TypeScript, Vitest, Biome. Builds on M1-A (`addWorkerWithLaunch`, ephemeral) + M1-B (pseudo-agent). No new deps.

**Spec references:** §6.3 (orchestrator spawn — full-goal), §10 (CLI verbs). Cascade-on-PTY-exit + boot orphan cleanup are a SEPARATE slice (M1-D-cleanup), not here.

## Background facts (verified)

- `team-authz.ts`: `TeamCommand = 'send'|'list'|'report'|'status'|'cancel'|'help'`; `commandAllowedForRole(role, command)` — orchestrator allowed set is `ORCHESTRATOR_COMMANDS`; `authenticateCliAgent({...})` validates identity; `requireCommandForRole(agent, command)` throws `ForbiddenError` if not allowed.
- `routes-team.ts`: handlers follow `route('POST', '/api/team/<verb>', async ({request, response, store}) => { ... })`; they read a JSON body, authenticate the calling agent, enforce the command, then call a `store` method and `sendJson`.
- `team.ts` (CLI): each verb reads `args`, builds `getHiveEnv()`, `postJson(baseUrl, '/api/team/<verb>', {...})`, prints the JSON result. `from_agent_id`/`token` come from env.
- `runtime-store`: `addWorkerWithLaunch(ws, WorkerInput, AgentLaunchConfigInput)` (M1-A), `deleteWorker(ws, workerId)`, `getWorker`/`listWorkers`.
- Launch config from a CLI preset: `resolveCommandPresetLaunchConfig(settings, commandPresetId)` (from `agent-launch-resolver.ts`, already used by `orchestrator-launch.ts`); built-in preset ids are `claude`/`codex`/`opencode`/`gemini` (`command-preset-defaults.ts`).
- Worker name normalization + duplicate check live in `workspace-store.addWorker` (throws `ConflictError` on dup) — `spawn` inherits that.

## File structure

- Modify: `src/server/team-authz.ts` — add `'spawn'`/`'dismiss'` to `TeamCommand` + orchestrator allow-set.
- Modify: `src/server/routes-team.ts` — add the two routes.
- Modify: `src/cli/team.ts` — add the two CLI verbs + usage text.
- Test: `tests/server/team-spawn-dismiss.test.ts` (integration, real spawn via dummy CLI env — NO node-pty mock), `tests/unit/team-authz-spawn.test.ts`.

---

## Task 1: Authorize the new commands

**Files:** `src/server/team-authz.ts`; Test: `tests/unit/team-authz-spawn.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest'
import { commandAllowedForRole } from '../../src/server/team-authz.js'

describe('team authz — spawn/dismiss', () => {
  test('orchestrator may spawn and dismiss', () => {
    expect(commandAllowedForRole('orchestrator', 'spawn')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'dismiss')).toBe(true)
  })
  test('workers may not spawn or dismiss', () => {
    expect(commandAllowedForRole('coder', 'spawn')).toBe(false)
    expect(commandAllowedForRole('coder', 'dismiss')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/team-authz-spawn.test.ts`
Expected: FAIL — `'spawn'` is not assignable to `TeamCommand` / returns false for orchestrator.

- [ ] **Step 3: Extend the command type + allow-set**

In `src/server/team-authz.ts`:

```ts
export type TeamCommand =
  | 'send'
  | 'list'
  | 'report'
  | 'status'
  | 'cancel'
  | 'help'
  | 'spawn'
  | 'dismiss'
```

Add `'spawn'` and `'dismiss'` to the `ORCHESTRATOR_COMMANDS` set (the set used by `commandAllowedForRole` for the orchestrator branch). Do NOT add them to any worker allow-set.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/unit/team-authz-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/team-authz.ts tests/unit/team-authz-spawn.test.ts
git commit -m "Authorize team spawn/dismiss for the orchestrator"
```

---

## Task 2: `spawn` + `dismiss` routes

**Files:** `src/server/routes-team.ts`; Test: `tests/server/team-spawn-dismiss.test.ts`

- [ ] **Step 1: Write the failing test (integration, real spawn — no PTY mock)**

Use the existing `tests/helpers/test-server.ts` harness (real `createAgentManager`, real DB in a temp `dataDir`) the other `tests/server` team tests use. Authenticate as the orchestrator (its agent id + token from the store). Assert: POST `/api/team/spawn` creates an ephemeral worker resolvable in `listWorkers` with `ephemeral=true`/`spawnedBy='orchestrator'`; POST `/api/team/dismiss` removes it; a non-orchestrator caller gets 403.

```ts
// Skeleton — fill bodies using the test-server helper pattern from
// tests/server/team-send-authz.test.ts (same auth + fetch shape).
import { describe, expect, test } from 'vitest'
import { startTestServer } from '../helpers/test-server.js'

describe('team spawn/dismiss', () => {
  test('orchestrator spawns an ephemeral worker, then dismisses it', async () => {
    const ctx = await startTestServer()
    try {
      const ws = ctx.store.createWorkspace(ctx.workspacePath, 'WS')
      const orch = ctx.store.getAgent(ws.id, `${ws.id}:orchestrator`)
      const token = ctx.store.peekAgentToken(orch.id)
      const spawn = await ctx.fetch('/api/team/spawn', {
        method: 'POST',
        body: JSON.stringify({
          hive_port: ctx.port, project_id: ws.id, from_agent_id: orch.id, token,
          role: 'reviewer', name: 'verify-1', cli: 'claude',
        }),
      })
      expect(spawn.status).toBe(201)
      const worker = ctx.store.listWorkers(ws.id).find((w) => w.name === 'verify-1')
      expect(worker).toBeTruthy()
      expect(ctx.store.getWorker(ws.id, worker!.id).ephemeral).toBe(true)
      expect(ctx.store.getWorker(ws.id, worker!.id).spawnedBy).toBe('orchestrator')

      const dismiss = await ctx.fetch('/api/team/dismiss', {
        method: 'POST',
        body: JSON.stringify({
          hive_port: ctx.port, project_id: ws.id, from_agent_id: orch.id, token,
          name: 'verify-1',
        }),
      })
      expect(dismiss.status).toBe(200)
      expect(ctx.store.listWorkers(ws.id).some((w) => w.name === 'verify-1')).toBe(false)
    } finally {
      await ctx.close()
    }
  })

  test('a worker (non-orchestrator) is forbidden from spawning', async () => {
    // create a worker, authenticate as it, POST /api/team/spawn → expect 403
  })
})
```

> Implementer: read `tests/helpers/test-server.ts` + `tests/server/team-send-authz.test.ts` first and match their exact harness API (`startTestServer` shape, how they auth + fetch). Do NOT mock node-pty. If `startTestServer` differs, adapt — the assertions above are the contract.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/server/team-spawn-dismiss.test.ts`
Expected: FAIL — routes return 404 (not registered).

- [ ] **Step 3: Implement the routes**

In `src/server/routes-team.ts`, add (mirroring the `send` route's auth pattern):

```ts
  route('POST', '/api/team/spawn', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      from_agent_id?: string
      token?: string
      project_id?: string
      role?: string
      name?: string
      cli?: string
    }>(request)
    const workspaceId = body.project_id ?? ''
    const agent = authenticateCliAgent({
      agentId: body.from_agent_id,
      token: body.token,
      workspaceId,
      getAgent: (id) => store.getAgent(workspaceId, id),
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'spawn')
    const role = (body.role ?? 'coder') as WorkerRole
    const name = body.name ?? `${role}-${Date.now().toString(36)}`
    const launchConfig =
      (body.cli ? resolveCommandPresetLaunchConfig(store.settings, body.cli) : undefined) ??
      { command: body.cli ?? 'claude', args: [] }
    const worker = store.addWorkerWithLaunch(
      workspaceId,
      { name, role, ephemeral: true, spawnedBy: 'orchestrator' },
      launchConfig
    )
    sendJson(response, 201, { ok: true, worker_id: worker.id, name: worker.name })
  }),
  route('POST', '/api/team/dismiss', async ({ request, response, store }) => {
    const body = await readJsonBody<{
      from_agent_id?: string
      token?: string
      project_id?: string
      name?: string
    }>(request)
    const workspaceId = body.project_id ?? ''
    const agent = authenticateCliAgent({
      agentId: body.from_agent_id,
      token: body.token,
      workspaceId,
      getAgent: (id) => store.getAgent(workspaceId, id),
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'dismiss')
    const worker = store.listWorkers(workspaceId).find((w) => w.name === body.name)
    if (!worker) {
      sendJson(response, 404, { error: `No such worker: ${body.name}` })
      return
    }
    store.deleteWorker(workspaceId, worker.id)
    sendJson(response, 200, { ok: true })
  }),
```

(Import `resolveCommandPresetLaunchConfig` from `./agent-launch-resolver.js`, `WorkerRole` type, and reuse existing `authenticateCliAgent`/`requireCommandForRole`/`readJsonBody`/`sendJson`. Match the EXACT `authenticateCliAgent` signature used by the `send` route — adapt the argument shape to whatever that route passes.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/server/team-spawn-dismiss.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes-team.ts tests/server/team-spawn-dismiss.test.ts
git commit -m "Add team spawn/dismiss routes backed by the atomic spawn primitive"
```

---

## Task 3: CLI verbs

**Files:** `src/cli/team.ts`; covered by an end-to-end CLI assertion if the harness supports it, else by the route tests above.

- [ ] **Step 1: Add the verbs** (mirror the `send` verb at team.ts:309)

```ts
  if (command === 'spawn') {
    const role = args[0]
    const name = readFlag(args, '--name')
    const cli = readFlag(args, '--cli')
    if (!role) throw new Error('Usage: team spawn <role> [--name <name>] [--cli <claude|codex|opencode|gemini>]')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/spawn', {
      hive_port: env.HIVE_PORT, project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID, token: env.HIVE_AGENT_TOKEN,
      role, ...(name ? { name } : {}), ...(cli ? { cli } : {}),
    })
    if (!response.ok) await throwHttpError(response)
    console.log(JSON.stringify(await response.json()))
    return
  }

  if (command === 'dismiss') {
    const name = args[0]
    if (!name) throw new Error('Usage: team dismiss <worker-name>')
    const env = getHiveEnv()
    const response = await postJson(getBaseUrl(env), '/api/team/dismiss', {
      hive_port: env.HIVE_PORT, project_id: env.HIVE_PROJECT_ID,
      from_agent_id: env.HIVE_AGENT_ID, token: env.HIVE_AGENT_TOKEN, name,
    })
    if (!response.ok) await throwHttpError(response)
    console.log(JSON.stringify(await response.json()))
    return
  }
```

Add a `readFlag(args, flag)` helper if one doesn't already exist (check team.ts — `parseCancelArgs` shows the flag-parsing style; reuse/extend it). Update `TEAM_USAGE` to document `spawn`/`dismiss`.

- [ ] **Step 2: Verify** Run `pnpm vitest run tests/cli/hive-cli.test.ts` (and any team CLI dispatch test) — expect green; add a dispatch case if the file has a pattern for it.

- [ ] **Step 3: Commit**

```bash
git add src/cli/team.ts
git commit -m "Add team spawn/dismiss CLI verbs"
```

---

## Task 4: regression gate + push

- [ ] `pnpm check && pnpm test` — expect biome clean + all green.
- [ ] `git push private feat/workflow-runtime`.

## Self-review

- **Spec coverage:** §10 verbs → Tasks 1-3; §6.3 orchestrator-spawn authorization → Task 1; ephemeral/spawnedBy stamping → Task 2 (via `addWorkerWithLaunch`).
- **Auth:** both routes call `authenticateCliAgent` + `requireCommandForRole(agent, 'spawn'|'dismiss')`; only the orchestrator's `ORCHESTRATOR_COMMANDS` set includes them → workers get 403.
- **Type consistency:** `TeamCommand` extended once; `WorkerInput` already carries `ephemeral`/`spawnedBy` (M1-A); `addWorkerWithLaunch` signature matches Task 2's call.
- **No PTY mock:** Task 2's integration test uses the real `test-server` harness; spawn creates a stopped worker (no PTY started), so the test needs no dummy CLI unless it also exercises a subsequent `team send`.

## Downstream

- **M1-D (cleanup):** cascade-stop orchestrator-spawned ephemeral workers on the orchestrator's PTY exit; delete orphan ephemeral workers on runtime boot (spec §6.3).
- **M1-E (events+UI):** `worker_spawned`/`worker_dismissed` events + frontend badges/animation + web handling of the `'workflow'` role and `ephemeral`/`spawnedBy` (spec §12).
