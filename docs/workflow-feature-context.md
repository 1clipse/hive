---
title: Hive Workflow Feature — Goal, Background, Decisions
purpose: Captures the full intent, design rationale, and user-directed pivots behind Hive's workflow runtime. The product spec lives in `docs/superpowers/specs/2026-04-18-hive-design.md`; per-milestone implementation plans live in `docs/superpowers/plans/2026-05-29-workflow-*.md`; this file is the *narrative* record — what we set out to do, where we missed the mark, what the user corrected, what's still open.
audience: anyone (human or agent) picking this work up later who needs to know the *why* behind the code before reading it.
status: living document — append as direction sharpens
---

# 1. Why Hive Has a Workflow Feature

Hive is, per `CLAUDE.md`, a browser-side multi-CLI-agent workbench. The original product was orchestrator-and-workers: one CLI agent (Claude Code / Codex / OpenCode / Gemini) talks to the user, dispatches tasks via `team send` to other CLI agents, who report back via `team report`. Workers are persistent team members. Communication is async, one-shot per dispatch.

That model works for *team coordination* but not for *programmatic fan-out*. The cases Hive's `team send` chain handles badly:

- **Wide parallel sweeps** — "find every place in the codebase that handles Windows paths and audit it." This is 20+ agents in parallel, each looking at a different angle. `team send` is per-worker, so this becomes 20 manual dispatches and no synthesis.
- **Multi-round refinement** — "find issues → adversarially verify each finding → keep going until a round comes back empty." This is a loop-with-state across rounds; orchestrator carrying that state in chat context will compact it away within a turn or two.
- **Structured pipelines** — "review the diff, then write tests for what review found, then run those tests." Three stages, each with their own fan-out, each consuming the prior stage's output.

Anthropic shipped Claude Code's *Dynamic Workflows* in May 2026 for exactly this: a script-driven runtime where loops, branching, and intermediate state live in JavaScript variables, not in Claude's context. We adopted the same architectural idea for Hive — but layered it on Hive's multi-CLI executor instead of on Claude's API.

# 2. What "the goal" actually is

The goal is **a workflow primitive that orchestrator agents can wield from a single PTY command, executing fan-out across Hive's multi-CLI worker fleet, with the runtime — not the orchestrator — holding the loop / branching / intermediate state.**

Decomposed:

1. **DSL-shaped familiarity, not runtime parity with Claude Code**: `agent / parallel / pipeline / phase / log / workflow` use the same names so patterns port structurally, but Hive's semantics are Hive-native: real PTY workers, Hive dispatch ledger, Hive stop/cancel, and no claim of 1:1 equivalence with Anthropic's runtime.
2. **Hive-native executor**: each `agent()` call spawns an ephemeral worker that is a *real CLI process* (claude/codex/opencode/gemini), in Hive's existing PTY model. Not an API subagent — a CLI subprocess.
3. **Orchestrator-driven invocation**: the orchestrator agent (sitting in its PTY) writes a workflow script in-line and runs it with one command. The user does **not** sit down and author `.hive/workflows/*.ts` files for normal use. Files are saved/reusable workflows; the common case is "write-and-run."
4. **Completion notification**: when a workflow finishes, the runtime injects a structured `<hive-system-reminder>` back into the triggering orchestrator's stdin — same envelope `team report` uses — so the orchestrator picks up the result without polling.
5. **Phase as a structural primitive**: `phase('Find')` isn't decoration; the UI renders a real phase tree so the user can see "this run has 5 phases, 22 agents in phase 1, currently in phase 3 round 2." Phases inside loops get auto-suffixed `R1 / R2 / ...` so the tree stays readable.
6. **Observable in the existing Hive UI**: the workflows drawer is the surface. Each run row expands to show the phase tree. Templates/inline editor/schedules sit beside it but are not the primary path.

# 3. Where this differs from Anthropic's Workflow tool — Hive-distinctive design

User direction (verbatim): **"不用完全一样啊，我们要做 hive 特色的 workflow"** — "doesn't need to be identical, we want Hive's own flavor."

The DSL is identical on purpose. The execution stack, the observability surface, and the product framing diverge:

| Dimension | Anthropic's Workflow tool | Hive's workflow |
|---|---|---|
| Who does the work | Claude (single vendor) via the Anthropic API | Any CLI agent — `claude / codex / opencode / gemini`, **mixed in one run** |
| Subagent model | API call to a named subagent type with a registered system prompt | Real PTY child process per `agent()` call, ephemeral worker row in DB |
| Observability surface | `/workflows` view with two-pane phase tree + agent panel | Single-column vertical phase strips in the Workflows drawer, designed for ambient watching from the right-rail panel |
| Resume | Same-session journal replay (cache unchanged prefix, re-run from first edit) | Interrupted runs stay interrupted (spec §13); UI offers manual restart only |
| Token budget | First-class `budget.total/spent/remaining`, `+500k` directives | Out of scope — PTY workers are opaque about their own usage |
| Worktree isolation | `agent({isolation:'worktree'})` per call | Opt-in `isolation: 'worktree'` — member runs in a temp git worktree; report names the branch to merge |
| Structured output | `agent({schema})` forces StructuredOutput tool with retry | Out of scope V1 — `agent()` returns the worker's report text |
| Cron / schedules | Saved workflows + `/schedule` slash command | First-class `workflow_schedules` table + cron-parser tick loop + UI |
| Cross-vendor mix | Cannot — one Claude vendor | Distinctive — vendor-per-agent badge is the *point* |

The thing nobody else has and Hive does have: **a single workflow that uses Claude to review correctness, Codex to refactor TypeScript, Gemini to summarize (because it's cheap), and Opencode for terminal-y tasks — in one run, with the same DSL.** Anthropic's tool architecturally can't do this; that's Hive's lane.

# 4. How the user corrected my course

Three direction-setting moments worth recording verbatim:

## 4.1 "This isn't workflow, this is a power-user script manager"

After the first end-to-end build (M0–M5b), the user opened the Workflows drawer and saw scripts + Start buttons. Their reaction:

> 我这我都不知道咋用，claude code 的 workflow 是由 agent 自己来定义的，而不是人，我们的我没看懂你这个做的什么玩意

Translation: "I don't even know how to use this. Claude Code's workflow is defined by the agent itself, not by humans — what is this thing you built?"

The diagnosis: I had built the *file-driven, power-user* slice of Anthropic's surface (`.hive/workflows/*.ts` + Saved Workflows) but missed the *natural-language-driven, orchestrator-fires-it* main path. In Anthropic's product, the user never writes `.ts` files — they say "audit this for X" and Claude writes the script. My drawer had Start/Schedule/Edit buttons but no "agent writes a workflow on the fly" path.

The corrective slice (M8): added `team workflow run --stdin / --inline` so the orchestrator's PTY fires inline workflows, added a completion-notification injection back to the orchestrator's stdin (mirroring `<task-notification>`), and rewrote the orchestrator system-reminder + rules to teach the orchestrator *when* to use it.

## 4.2 "Are these REALLY the same?"

After I claimed the runtimes were "API-compatible, world-view-compatible, executor-different," the user pushed back:

> 真的一样吗，claude code 我看会根据任务拆分多个阶段每个阶段也会有根据任务 1-多不等的 agent 在执行，你应该比我清楚吧

Translation: "Are they really the same? I see Claude Code splits the task into multiple phases, each phase has anywhere from 1 to many agents executing. You'd know better than me."

The honest answer (acknowledged in chat): the DSL is the same but the *observability* gap was real. Hive's `phase('Find')` was just a string field on the run row; the UI rendered a flat list of dispatches with no phase grouping. Users couldn't see what the user was actually seeing in Claude Code's screenshot — phase tree on the left, 22 agents in the current phase on the right.

The corrective slice (M9): added `phase` + `label` columns to dispatches, made the runner auto-round same-name phases (`phase('Find')` second time → "Find R2"), and built collapsible phase strips in the drawer. Each strip shows phase name, agent count, completed/total counter, and expands to the per-agent fleet — single-column vertical (Hive-flavor), not the two-pane wide Claude Code design.

## 4.3 "Don't clone — give Hive its own flavor"

When I proposed mirroring Claude Code's two-pane phase view 1:1, the user redirected:

> 不用完全一样啊，我们要做 hive 特色的 workflow

Translation: "doesn't need to be identical, we want Hive-distinctive workflow."

This unlocked the single-column-vertical-strips design (fits the drawer's narrow right-rail layout) and surfaced the missing distinctive features list — vendor-per-agent badges, click-to-peek into the worker PTY, multi-vendor mix as a first-class concept. Those are the *next* slice's targets.

# 5. What ships in `feat/workflow-runtime` today (M0 → M9)

| Slice | Adds |
|---|---|
| **M0** | per-agent stdin write queue (foundation) |
| **M1-A** | schema v19, ephemeral worker model, atomic `addWorkerWithLaunch`, defensive hydration for foreign DBs |
| **M1-B** | `__workflow__` pseudo-agent (dispatch identity for the runner) |
| **M1-C** | `team spawn` / `team dismiss` verbs (authz + routes + CLI) |
| **M1-D** | ephemeral cleanup (boot sweep + cascade on orchestrator exit) |
| **M2-A** | schema v20, `workflow_runs` store, boot interrupted-sweep |
| **M2-B** | script loader (meta extract + esbuild transpile + sha256 hash, lazy esbuild to survive jsdom) |
| **M2-C** | runtime core — DSL, dispatch-await registry, workflow lifecycle |
| **M2-D** | HTTP routes — list scripts / start run / list runs / get run |
| **M3-A** | `workflow()` nesting (recursive runner over sibling `.hive/workflows/*.ts`) |
| **M3-B** | schema v21, `workflow_schedules` store + cron-parser tick loop + CRUD routes |
| **M4** | UI drawer — topbar toggle, scripts list, Start, Recent Runs (polling) |
| **M4.5** | schedules UI in drawer — create, pause/resume, delete |
| **M4.6** | expandable run rows showing dispatch timeline |
| **M5** | built-in template gallery — 3 starter workflows + install route |
| **M5b** | inline source editor modal in drawer (textarea + save) |
| **M7** | `stopWorkflowRun` — cancel running workflow, mark `status='stopped'` |
| **M8** | `team workflow run --stdin/--inline` from orchestrator PTY + completion notification injected back to orchestrator stdin + orchestrator system prompt teaches when to use it |
| **M9** | `phase` + `label` columns on dispatches, R1/R2 auto-rounding, phase strips in drawer |

Schema-divergence resilience pattern (learned hard during this work): foreign-built DBs may already have `schema_version >= 21` from a *different* migration line. Every new column gets an idempotent `ensureColumn` call in the base `initializeRuntimeDatabase` block (not gated on `appliedVersions.has(N)`); every new table goes in the base `CREATE TABLE IF NOT EXISTS` block. The version-gated migrations stay but are belt-and-suspenders. Two columns and one table caught users mid-test.

# 6. What's NOT done yet — open Hive-distinctive surface

These are the next slices, in priority order based on user feedback:

## 6.1 Vendor badges per agent (high priority — leans into Hive's distinctive)

Each agent row in a phase strip should show which CLI vendor it ran on:

```text
● #1 find:powershell-deep   🌀 claude   → "Found 3 issues"
○ #2 find:cmd-parser-deep   🔵 codex    queued
◐ #3 find:sqlite-windows    🟢 opencode awaiting…
```

Data path: dispatch.toAgentId → workers table → launch_config.command. Need to either (a) join through this in `listWorkflowRunDispatches`, or (b) snapshot the vendor onto the dispatch row at create time. (a) is correct; (b) is faster.

## 6.2 Click-an-agent → peek into its PTY (high priority — Hive's other distinctive)

Anthropic's tool has no terminals — agents are API calls. Hive's agents are *real PTYs*. A user looking at a workflow's phase strip should be able to click into any agent and see its actual terminal output (the same `last_pty_line` we already track for persistent workers). This is the "x-ray vision into the fleet" feature Claude Code architecturally can't offer.

Implementation: the run-detail GET already returns dispatches with `toAgentId`. The web client already polls `last_pty_line` for persistent workers. The plumbing for ephemeral workflow workers is the same — but the workers get deleted after their `agent()` call ends. To make peek work, we'd need to either (a) keep the worker around past the dispatch (changes the ephemeral model), or (b) snapshot the worker's full PTY output onto the dispatch row at dismiss time (cheap, log-style).

## 6.3 Multi-vendor mix in script + UI emphasis

Workflows should be able to write `agent('...', { cli: 'codex' })` and have the runtime spawn a Codex worker (not the default Claude). M2-C accepts `opts.cli` and forwards to `addWorkerWithLaunch`, so the data path exists. What's missing:

- A worked example template that mixes vendors (e.g., Claude for review, Codex for refactor)
- UI emphasis: the Workflow run header should say "3 vendors used" or similar when ≥2 vendors appear

## 6.4 Structured output

`agent('...', { outputSchema: { key: 'type' } })` is implemented as a light contract: the runner appends JSON-block instructions to the dispatch, parses the final fenced `json` block from the worker report, and falls back to `{ text }` if parsing misses. It does not do full JSON Schema validation or retries. A future hardened version could accept real JSON Schema, validate via `ajv`, and retry on mismatch.

## 6.5 Worktree isolation

`agent(prompt, { isolation: 'worktree' })` is opt-in. Hive creates a git worktree under `os.tmpdir()/hive-worktrees/` on branch `hive/wf-<run>-<step>-<label>` from the workspace `HEAD`, and the worker PTY starts with `cwd` set to that directory. The resolved report ends with a one-line `<hive-worktree branch="..." base="..." kept="true|false" path="..."/>` tag (and `result.worktree` when `outputSchema` is set) so the script can merge. Cleanup keeps the branch when it is ahead of base, deletes it when nothing changed, and never throws. A non-git workspace fails that `agent()` call instead of falling back to shared. Use it when `parallel()` members would otherwise edit the same files.

# 7. How to test what's there today

Two paths, both tested while building:

## 7.1 Drawer-direct (no orchestrator needed)

1. Open http://127.0.0.1:5180/ → pick a workspace.
2. Topbar → click **Workflows** → drawer opens.
3. Click **+ Template** → install `multi-perspective-review`.
4. Click **Start** next to it.
5. Expand the new run row in **Recent Runs** to see phase strips populate as agents fire.

## 7.2 Orchestrator-driven Hive workflow path

1. Restart the orchestrator in your workspace (so it reloads the system prompt with the M8 workflow guidance).
2. In the orchestrator's PTY, type a natural-language fan-out request: "并行 review 当前 git diff:正确性、安全、性能三个角度,最后综合"
3. Orchestrator should write `team workflow run --stdin <<'EOF' ... EOF` itself.
4. Workflow run appears in the drawer; phase strips populate.
5. On completion, the orchestrator gets a `<hive-system-reminder>` injected with the summary; it synthesizes back to the user.

If step 3 doesn't happen — the orchestrator's prompt isn't strong enough yet. That's the next iteration target.

# 8. Reference materials

- **Spec**: `docs/superpowers/specs/2026-04-18-hive-design.md` — the original design document covering Hive overall (orchestrator/worker model, `team` CLI, role templates, crash recovery, task graph).
- **Research**: `docs/claude-code-workflow-research.md` — 1142-line comprehensive reference on Claude Code's workflow system, agent SDK, hooks, skills. Use it as background only; Hive borrows the DSL shape but does not implement Claude Code's runtime 1:1. In a Hive PTY, workflows must run through `team workflow run`, never the host CLI's native workflow/subagent surface.
- **Per-slice plans**: `docs/superpowers/plans/2026-05-29-workflow-*.md` — every slice has a TDD-style plan with red→green steps. Read these before reverse-engineering the code.
- **Project context**: `CLAUDE.md` — current project context; `docs/release.md` — public repository release process.

# 9. What I (the agent that built this) was told and how I behaved

The user's standing direction was:

> 行，你作为总指挥推进，不用向我汇报

Translation: "OK, you act as commander and push forward, no need to report back."

What this granted: I made design calls, ordered slices, picked which gaps to close first, and didn't ask for permission between slices. The user reserved interventions for moments when the direction was wrong (the three pivots in §4). This is the autonomy model future maintainers should default to unless the user explicitly takes the wheel back.

What it didn't grant: lying about parity. When the user asked "is this really the same as Claude Code?", the right move was to enumerate the actual gaps honestly (§3 table) — *not* to defend the previous claim. That's the trust calibration that keeps this autonomy model working.
