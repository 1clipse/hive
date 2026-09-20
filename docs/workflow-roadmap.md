# Hive Workflow — Optimization Roadmap

Working document distilled from a 2026-05-29 multi-lens audit of the workflow
feature (runtime / observability / orchestrator teaching / reliability /
hive-distinctive leverage — 5 parallel agents + a synthesis pass). Each item
has a concrete file:line citation and a one-paragraph implementation note;
trace back through `docs/workflow-feature-context.md` and
`docs/claude-code-workflow-research.md` for the full design history.

The audit findings (the inputs to this synthesis) live in
`/private/tmp/claude-501/...tasks/w6c1zvo30.output` for one session — they are
not re-derivable, so anything important to preserve gets pulled into this doc.

## How to read this

- **TIER 1** — current pass. Reliability / honesty bugs that make the runtime
  lie to the user or hang silently, plus orchestrator-teaching gaps that
  cause foreign CLIs (Codex / Gemini) to invisibly fall back to single-vendor
  Claude or to bypass Hive entirely. All S effort.
- **TIER 2** — next pass. Capability + UX gaps. M effort each.
- **TIER 3** — opt-in / experimental. L effort, design questions open.

The highest-leverage single change is **TIER 1 #1** (PTY exit hangs the
awaiter for 10 minutes) — it is the only known bug where a workflow run
reliably stalls in `running` and the UI shows a green spinner over a dead
process.

---

## TIER 1 — current pass

| # | Item | Where | Status |
|---|------|-------|--------|
| 1 | Workflow worker PTY exit hangs the awaiter 10 min | `workflow-runner.ts:170-180`, `agent-run-exit-handler.ts` | [x] 405ad51 |
| 2 | Stop during parallel/pipeline silently becomes `completed` | `workflow-runner.ts:192-209,240-252` | [x] ae7d750 |
| 3 | parallel() swallows every failure to null | `workflow-runner.ts:192-194` | [x] ae7d750 |
| 4 | Delete workspace orphans workflow_runs / schedules / dispatches | `workspace-store.ts:96-108` | [x] 8d198f9 |
| 5 | Scheduler tick can fire same schedule twice on overlap | `workflow-scheduler.ts:42-83` | [x] ce8a4ca |
| 6 | Completion reminder advertises non-existent `team workflow show` | `runtime-store.ts:352-354` | [x] 2588a9d |
| 7 | Nested workflow() breaks under inline parent | `workflow-runner.ts:219-233` | [x] 9ea14d0 |
| 8 | Cheat-sheet hides the multi-vendor (`{ cli: 'codex' }`) opt | `hive-team-guidance.ts:47,51` | [x] a5fcd65 |
| 9 | `parallel(thunks)` rule missing — classic foot-gun | `hive-team-guidance.ts:47` | [x] a5fcd65 |
| 10 | Don't claim "同构" with CC's Workflow tool; deny it | `hive-team-guidance.ts:20,44,47` | [x] a5fcd65 |
| 11 | Loops of `team send` not flagged as anti-pattern | `hive-team-guidance.ts:47` | [x] a5fcd65 |
| 12 | Result panel is `<pre>` JSON, no Copy / Expand / Markdown | `WorkflowsDrawer.tsx:320-336` | [x] 3170317 |
| 13 | No Retry button in runs list | `WorkflowsDrawer.tsx:240-369` | [x] 3170317 |
| 14 | Run row hides args / phase / duration / step count | `WorkflowsDrawer.tsx:268-313` | [x] 3170317 |

### Notes

- **#1 → #3 are one runtime PR.** Fixing the PTY-exit notify path
  (`onAgentExit` → `workflowDispatchAwaiter.notifyCancel`) cleanly composes
  with the parallel/pipeline rethrow-on-stop fix; doing them together avoids
  a tangled second commit.
- **#8 / #9 / #10 / #11 are one prompt PR** — all in
  `src/server/hive-team-guidance.ts` plus `buildProtocolDoc` regen.
- **#14 depends on API surface change** (expose `args` + `agentCount` on
  `WorkflowRun`). #13 (Retry) is blocked on that, since the only sane Retry
  invokes the original args. Doing them together.
- **#6** picks "implement `team workflow show`" over "drop the sentence" —
  the per-agent transcript is the orchestrator's only structured escape
  hatch beyond the 200-char per-step summary.

---

## TIER 2 — current pass (shipped)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1 | `agent()` ignores `opts.model` — feature parity hole | M | [x] 8142ae2 |
| 2 | No agent-cap / concurrency cap / runaway backstop | M | [x] 2dc3bc4 |
| 3 | `log()` writes to console.log — invisible to UI + orchestrator | M | [x] 4a6e6ef |
| 4 | `agentType` clamped to 4 built-ins — drops custom roster | M | [x] a676821 (anchor) |
| 5 | Nested workflow runs flat — no `parent_run_id` | M | [x] b7bedf4 |
| 6 | Can't peek into ephemeral worker's PTY mid-run | M | [x] 4f0e4c0 |
| 7 | Runs list lacks status filter + dispatch jump | M | [x] 4f0e4c0 |
| 8 | `args` global + `--args` flag undocumented / unimplemented | M | [x] 63140a2 |
| 9 | No examples for judge / loop / adversarial patterns | M | [x] 80bdf9e |
| 10 | Stop race: dispatch landed but awaiter not registered yet | M | [x] f6f0681 |
| 11 | No per-run runtime budget (`maxAgentCalls` / `maxDurationMs`) | M | [x] 2dc3bc4 |

The TIER 2 anchor was **#4 (custom roster integration)** — every other
workflow tool can spawn fresh agents; only Hive can hand a workflow stage
to a pre-curated workspace member, and we hadn't exposed it.

---

## TIER 3 — experimental

| # | Item | Effort | Why deferred |
|---|------|--------|--------------|
| 1 | `agent({ schema: JSONSchema })` structured output | L | needs ajv + retry-on-malformed + return-type widening |
| 2 | `resumeFromRunId` cached prefix replay | L | "interrupted" status is currently a UI lie; zero parts wired |

Both are strict CC-parity items. Worth taking on once #5 (parent_run_id)
gives us the schema discipline to track per-call results properly.

---

## Out of scope here

- Worktree isolation (mentioned in earlier private context, but workflow
  workers are PTY processes — git worktree is solving a different problem).
- Heterogeneous-fleet showcase workflow templates. After TIER 1 #8 + TIER 2
  #1 / #4 ship, ship one canonical 3-vendor example (`claude` review +
  `codex` implement + `gemini` test) as a template.

---

## Audit log

| Date | Lenses | Findings | Synthesizer |
|------|--------|----------|-------------|
| 2026-05-29 | runtime, observability, teaching, reliability, hive-distinctive | 25 raw, 27 after synthesis (some dedup, some split) | claude-opus-4-7 |

The original audit used local scripts that are not distributed with this repository.
For future audits, check the current workflow implementation and integration tests.
