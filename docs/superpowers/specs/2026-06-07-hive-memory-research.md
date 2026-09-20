# Hive Memory Research and Direction

**Date**: 2026-06-07 (ambient refinement 2026-06-08)
**Status**: M1/M2 implemented on `docs/hive-memory-research`; ambient-experience refinement decided 2026-06-08; M1.5 A1-A7 implemented and passed final full gate/self-review; M3 provider bridge later
**Owner**: Hive private planning

This document captures the memory research for Claude Code, Codex, and Hermes Agent, then turns it into a concrete direction for Hive's cross-agent memory work. It is not an implementation spec yet. The next step should be a reviewed product/technical spec with schema, protocol, UI, and test requirements.

## Decisions (2026-06-07)

Decided with the user after follow-up research (multi-agent memory landscape, Hermes deep-dive, codebase mapping — see "Follow-Up Research" below):

1. **Goal statement**: make the team's collaboration history (episodic layer) and distilled project knowledge (semantic layer) show up automatically at dispatch and recovery, and be queryable on demand.
2. **First milestone ships both layers plus injection.** Episodic recall (FTS over messages/dispatches) and explicit semantic memory (`memory_entries`) land together with all three injection points. Plain CRUD without injection has no perceivable value; the experience moment is a dispatch arriving with relevant team memory attached ("Worker A's pitfall reaches Worker B").
3. **Write policy: orchestrator writes active directly; worker writes become candidates.** Mirrors Letta's single-owner best practice and Hive's queen-bee metaphor. Avoids both full-approval friction (nobody uses it) and full-auto noise (shared-store poisoning).
4. **SQLite is the source of truth, with one-way export to `<workspace>/.hive/memory.md`.** Human-auditable file for review/grep/git without two-way sync conflicts. Resolves Open Question 2.
5. **Automatic extraction is dream-style offline batch consolidation (M2), not per-report inline extraction.** Idle/scheduled/manual batch runs over protocol messages, never PTY bytes. Dream output **auto-applies — no user approval gate** (user direction, 2026-06-07): hygiene operations on existing entries (dedupe/merge, absolute-ize relative dates, archive stale — archive, never delete) apply directly; net-new extracted entries also activate directly but are tagged `source: dream` with confidence and rank below explicit entries at injection time. Every run emits a diff-style dream report, revertible as a unit; user control is post-hoc audit + rollback + per-workspace toggle, not pre-approval. Per-turn/per-report inline extraction stays rejected: Hermes' aggressive background review is a documented noise source (see Follow-Up Research).

## Ambient Experience Decisions (2026-06-08)

After M1+M2 shipped, a grilling session refined the product bar to **ambient / zero-cognitive-load**: knowledge must accumulate and resurface without the human ever operating memory. The human's required touchpoints = none; optional = the audit panel. Curation burden is pushed onto the orchestrator (queen bee) and the dream job, never the user. These decisions supersede the M1 explicit-write default where they conflict.

1. **Dual write path.** Dream is the primary writer (auto-extracts from protocol messages → `active`, `source:dream`, ranked low). The orchestrator keeps a high-precision inline `team memory add` (→ `active`) for genuinely reusable cross-session insight captured the moment it appears. **Workers no longer write memory directly** — their discoveries flow via dream extraction or an orchestrator inline-add after reading the report.
2. **Dream cadence = idle-triggered + floor.** Run when the workspace goes idle (no working agent) after a short debounce, with a minimum-interval floor (~15–30 min) and a relaxed threshold (a new report suffices; drop the ≥20-message gate). Daily remains a backstop. Latency drops from ~24h to minutes without competing for the CLI or burning quota.
3. **Candidate queue removed.** Worker direct-write is gone, so nothing produces `candidate` by default. `team memory add` becomes orchestrator-only (→ active). Dream output auto-applies to `active` (no approval gate, per 2026-06-07 decision #5). The UI drops the Candidate tab. The `status='candidate'` column is retained but vestigial, reserved for a future opt-in review mode.
4. **Total silence.** No toasts, no badges, no counts, no "learned X" prompts. Memory works invisibly; the panel is meaningful only when the user goes looking. The `<hive-memory>` block stays in dispatches as passive transparency for whoever reads the terminal, but nothing ever pulls the user's attention.
5. **Staleness guardrail = soft decay + supersession.** Dream archives an entry when newer evidence contradicts it (supersession). Injection ranking adds a recency-decay factor so long-unconfirmed entries sink below the budget naturally (soft, not hard-deleted). Dispatch injection only pushes entries with `confidence ≥ threshold`; below-threshold entries remain pullable via `team recall`. High-precision push channel, high-recall pull channel. This directly targets the documented auto-memory failure (Mem0's "confidently wrong the moment a fact changes").
6. **Scope = ambient only.** This milestone is the ambient-experience refinement (decisions 1–5, 7–8). It does NOT include the M3 provider bridge (EverOS) or user-global cross-project preference memory — those remain separate later milestones.
7. **Same-session propagation stays the orchestrator's job.** Dispatch injection pushes only curated `memory_entries`, never raw reports — the push channel stays clean. Same-session "Worker A → Worker B" is the orchestrator's core decomposition responsibility (it just read A's report and is dispatching B) plus the inline-add for durable capture. Raw episodic history is reachable only on-demand via `team recall`. Residual gap (orch drops it AND dream hasn't run → B may repeat A's mistake) is accepted — it is the same gap that exists today and is the orchestrator's job to prevent.
8. **Write precision: orchestrator inline-add is high-precision, conservative, evidence-gated.** It fires only for the rare clearly-reusable cross-session insight (a project convention, a repeated pitfall, an architectural decision), and dedupes against existing entries before adding. "Nothing worth saving" is a valid, expected outcome — explicitly countering Hermes' "always save something" bias that fills memory with noise. Completeness is dream's job, not the orchestrator's.

## Why This Exists

Hive is a multi-CLI-agent workspace. Claude Code, Codex, Hermes, Gemini, and other CLIs already have their own internal memory/session mechanisms, but those memories are scoped to a single CLI agent. Hive needs a team-level memory layer so one agent's discovered project fact, decision, or pitfall can help future orchestrator and worker sessions.

The key correction from discussion: **Hive memory must not be owned by a worker role, worker name, or "collaboration number."** Workers can be deleted, renamed, recreated, made ephemeral, or launched under a different role. Role templates can be copied, edited, or removed. Those are unstable lifecycle objects.

The stable owner for project memory is the workspace/team boundary.

## Sources Reviewed

Primary sources:

- Claude Code memory docs: https://code.claude.com/docs/en/memory
- Claude Code sessions docs: https://code.claude.com/docs/en/sessions
- Claude Code context window docs: https://code.claude.com/docs/en/context-window
- Claude Code settings docs: https://code.claude.com/docs/en/settings
- Claude Code sub-agents docs: https://code.claude.com/docs/en/sub-agents
- Codex memories docs: https://developers.openai.com/codex/memories
- Codex AGENTS.md docs: https://developers.openai.com/codex/guides/agents-md
- Codex skills docs: https://developers.openai.com/codex/skills
- Codex MCP docs: https://developers.openai.com/codex/mcp
- Codex manual snapshot fetched 2026-06-07: https://developers.openai.com/codex/codex-manual.md
- Hermes memory docs: https://hermes-agent.ai/features/persistent-memory
- Hermes memory provider docs: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md
- Hermes sessions docs: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md
- Hermes skills docs: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md
- Hermes memory tool source: https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py
- Hermes state source: https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py
- Honcho Hermes integration: https://docs.honcho.dev/v3/guides/integrations/hermes

Local Hive references:

- `README.md` "跨 Agent 的长时记忆"
- `CLAUDE.md`
- `AGENTS.md`
- `docs/superpowers/specs/2026-04-18-hive-design.md`
- `src/server/message-log-store.ts`
- `src/server/recovery-summary.ts`
- `src/server/agent-startup-instructions.ts`
- `src/server/agent-stdin-dispatcher.ts`
- `src/server/command-preset-defaults.ts`

## Claude Code Findings

Claude Code separates persistent context into instruction files, auto memory, subagent memory, and session transcripts.

### Instruction Memory

Claude Code uses `CLAUDE.md` and rules files as persistent instruction context.

Observed structure:

- Organization/user/project/local levels can all contribute guidance.
- Typical paths include user-level `~/.claude/CLAUDE.md`, project-level `./CLAUDE.md`, local `./.claude/CLAUDE.md`, and local-only files such as `./CLAUDE.local.md`.
- Directory-level guidance is layered from broader to narrower scope.
- Nested project guidance can be loaded when the model enters or reads that subtree.
- `@path` imports help organize files but do not save context once imported.

Important boundary:

- These files are instructions, not an enforcement layer. Required runtime behavior should still be enforced by settings, hooks, permissions, or application protocol.

### Auto Memory

Claude Code also has auto memory.

Observed structure:

- Memory lives under a project-specific local directory such as `~/.claude/projects/<project>/memory/`.
- `MEMORY.md` and topic files hold generated project memory.
- A bounded head of `MEMORY.md` is loaded at session start.
- Topic files are read on demand.
- Users can inspect, edit, and delete the generated local markdown files.
- Auto memory can be controlled with `/memory`, settings, and environment variables.

Design implication:

- Claude Code uses a small always-loaded summary plus larger on-demand memory files. This is a good pattern for Hive's startup and dispatch injection budget.

### Subagent Memory

Claude Code supports subagent-specific memory.

Observed structure:

- Subagent memory can be stored under paths associated with the subagent definition, such as user or project-level agent memory folders.
- It is scoped to a named subagent and loaded when that subagent runs.

Hive caution:

- This model should not be copied directly. Hive workers are runtime entities, not durable subagent definitions. A Hive worker can be deleted, renamed, restarted, or respawned with a different role.

### Sessions

Claude Code sessions are transcript continuity, not memory.

Observed structure:

- Session JSONL files live under `~/.claude/projects/<project>/<session-id>.jsonl`.
- `claude --continue` resumes the latest session in the current directory.
- `claude --resume <id>` resumes a specific session.
- Resume restores the same transcript/tool context. It is not a cross-session recall layer.

Hive implication:

- Hive should keep using native CLI resume for per-agent continuity, but should not treat native CLI resume as the team memory layer.

## Codex Findings

Codex uses a layered customization and memory model: `AGENTS.md`, config, skills, plugins, MCP, thread/session state, and explicit memories.

### AGENTS.md

Codex uses `AGENTS.md` as durable instruction context.

Observed structure:

- Global guidance can live under the Codex home directory.
- Project guidance is discovered from the project root down to the current working directory.
- Files closer to the current directory are appended later and override broader guidance.
- Instruction discovery happens at run/session start and has a byte budget.

Important boundary:

- Codex documentation explicitly recommends keeping required team guidance in `AGENTS.md` or checked-in docs. Memories are a helpful local recall layer, not the source of rules that must always apply.

Hive implication:

- Hive memory must not replace `.hive/tasks.md`, `AGENTS.md`, or runtime protocol enforcement. It should recall helpful context; it should not carry hard protocol requirements.

### Config

Codex stores durable configuration in `config.toml`.

Observed structure:

- User-level config is under `~/.codex/config.toml`.
- Trusted projects can have project-scoped `.codex/config.toml`.
- Config controls model, sandbox, approvals, MCP, hooks, and feature flags.

Hive implication:

- Hive memory feature flags and per-workspace enablement should be explicit configuration, not implicit behavior.

### Skills and Plugins

Codex skills are programmatic/reusable workflow memory.

Observed structure:

- Skills are directories with `SKILL.md`, optional references, scripts, and assets.
- The initial prompt only contains a bounded list of skill metadata.
- Codex reads the full skill only when it decides to use it.
- Plugins are distribution bundles for skills, apps, MCP servers, and related assets.

Hive implication:

- "How to perform a recurring workflow" should become a Hive skill/workflow/template, not a natural-language memory entry.
- Memory can reference a skill, but skill lifecycle should be separate.

### MCP

Codex treats MCP as external live context and tools.

Observed structure:

- MCP server instructions and tools are loaded from config or plugins.
- MCP is a way to access external current/private data, not a place to store generated memory by default.

Hive implication:

- If Hive memory later connects to EverOS, Honcho, Mem0, or another backend, it should be surfaced as a memory provider with explicit policy, not silently mixed into `team list` or CLI runtime state.

### Memories

Codex has explicit memories, but they are opt-in.

Observed structure:

- Memories are off by default.
- They are enabled in settings or with `[features].memories = true`.
- They are stored locally under `~/.codex/memories/`.
- Codex can turn eligible prior threads into local memory files in the background.
- Memory generation is asynchronous and may wait until a thread has been idle.
- Controls include whether a thread uses existing memories and whether it can be used to generate future memories.
- Settings can prevent memory generation from threads that used external context such as MCP or web search.
- Memory files are generated state and should be reviewed before sharing.

Hive implication:

- Hive should provide per-workspace and per-session memory controls:
  - use existing memory
  - allow current session/report to generate candidate memory
  - disable memory extraction when external/private context was used

## Hermes Findings

Hermes has the richest productized memory design among the three. It combines small built-in memory files, SQLite/FTS session search, external memory providers, and skills.

### Built-In Memory Files

Hermes uses two small memory files:

- `MEMORY.md`: environment facts, project facts, recurring pitfalls, and durable rules.
- `USER.md`: user profile and preferences.

Observed behavior:

- Files live under the Hermes memory directory, commonly under `~/.hermes/memories/`.
- The prompt includes bounded snapshots, around a few thousand characters.
- Memory can be updated with memory tools.
- Updates land on disk immediately.
- The current prompt snapshot remains frozen; new memory affects the next session/turn depending on the mechanism.

Hive implication:

- Hive should maintain a compact digest for startup and recovery injection, but the full store should remain queryable.

### SQLite and FTS Session Search

Hermes stores sessions and messages in SQLite and uses FTS.

Observed behavior:

- `~/.hermes/state.db` stores sessions/messages.
- FTS indexes messages for cross-session search.
- `session_search` returns actual message windows with surrounding context rather than summarizing them first.
- Session resume reopens stored sessions and can follow parent/child session chains after compaction.

Hive implication:

- Hive already has SQLite runtime state and a messages table. A memory feature should build on durable message/dispatch facts, not PTY transcript bytes.
- A `team memory search` command should return evidence-backed entries or source excerpts, not opaque model summaries only.

### Memory Providers

Hermes supports external memory providers such as Honcho.

Observed behavior:

- External providers are additive. They do not replace built-in file memory.
- Only one external provider is enabled at a time.
- Provider modes can inject context directly or expose provider tools.
- Honcho models user/AI peers and session-level representations.
- Review/background memory jobs intentionally skip the external provider in some cases to avoid writing review prompts into provider memory.

Hive implication:

- Hive should support a provider abstraction, but the first version should keep SQLite as the source of truth.
- Provider writes must be auditable and must avoid recording internal review prompts or system wrappers as durable memory.

### Skills

Hermes treats skills as procedural memory.

Observed behavior:

- Skills live under `~/.hermes/skills/`.
- Agent tools can list, view, create, and patch skills.
- Skills are progressively loaded.

Hive implication:

- Hive should separate:
  - factual memory: "this repo uses pnpm"
  - preference memory: "the user prefers concise status"
  - procedural memory: "how to run release QA"

Procedural memory should likely live in workflows/skills rather than free-form memory entries.

## Cross-System Patterns

### Pattern 1: Rules Are Not Memories

All three systems separate hard instructions from helpful recall.

Hive decision:

- Keep hard rules in repo docs, settings, runtime protocol, route validation, and tests.
- Memory should not be used to enforce `team send`, status transitions, permissions, or schema contracts.

### Pattern 2: Resume Is Not Memory

All three systems have session/transcript continuity separate from cross-session memory.

Hive decision:

- Native CLI resume remains Layer A for individual agent continuity.
- Hive memory is a team/workspace recall layer that survives agent deletion and native session loss.

### Pattern 3: Small Always-Loaded, Large On-Demand

Claude Code and Hermes both use bounded always-loaded summaries plus larger on-demand memory.

Hive decision:

- Startup injection should include only pinned and high-signal digest.
- Dispatch injection should retrieve task-relevant top-K memories.
- Recovery injection should include a bounded digest plus source-aware open-task facts.

### Pattern 4: Generated Memory Needs User Control

Codex and Claude Code expose memory controls. Hermes exposes tools and files.

Hive decision:

- Memory must be inspectable, editable, removable, and disableable from the UI.
- Automatic extraction should produce candidate memories before active insertion, at least in the first version.

### Pattern 5: Programmatic Knowledge Is Separate

Codex and Hermes both treat skills as a separate layer.

Hive decision:

- Put repeatable procedures into workflows/skills/templates.
- Put stable facts and decisions into memory.

## Follow-Up Research (2026-06-07 review)

Three research passes ran before the direction discussion: a codebase map, a Hermes deep-dive, and a multi-agent memory landscape survey. Findings that shaped the decisions:

Hermes corrections and lessons:

- Core Hermes has **no "dreaming" feature**. It is a community proposal (issue #25309), rejected from core twice (PRs #25690, #25314), now a third-party plugin. The built-in mechanism is a per-turn, cadence-gated background review fork (`agent/background_review.py`, fires every ~10 turns).
- That review's "always save something" prompt bias is a confirmed noise source: duplicate writes, misclassification (bug #30220), one daily driver reported ~30 of 70 entries were meta-noise about memory management itself; MEMORY.md's 2,200-char hard cap sits perpetually ~99% full, forcing manual cleanup — the exact failure Hive's dream hygiene pass should prevent.
- Agents are unreliable judges of their own learning (community-confirmed "self-congratulation"); Hermes is pivoting to execution-trace-based signals. Hive's dream job should judge by protocol evidence (reports, dispatch outcomes), not agent self-assessment.
- `session_search` returns raw FTS5 message windows (±N messages, bookends, scroll cursor) with no LLM summarization; a trigram tokenizer was added specifically for CJK matching.

Multi-agent landscape (Letta, Mem0, claude-flow, CrewAI/AutoGen/LangGraph, Zep/Graphiti):

- Converged trend: project-scoped memory with per-agent private + explicit shared layers; multi-dimensional scope tags (Mem0's user/agent/session/org) combined at retrieval.
- Letta shared memory blocks: append-only insert is concurrency-safe; whole-block rewrite is last-writer-wins. Official best practice: **a single owner agent does heavy edits, others append** — direct support for orchestrator-as-owner.
- Shared stores amplify staleness and poisoning: one bad write cascades to every consumer. Full-auto extraction + full sharing (claude-flow hive-mind) reads as demo capability, not production-proven practice.
- Retrieval consensus: small always-loaded digest + larger on-demand query; stuffing everything into prompts is a documented context-distraction failure mode.

Hive-specific asset: protocol messages are already structured, attributed, workspace-isolated events — cleaner raw memory input than any surveyed system's transcript scraping. This is what makes the episodic layer nearly free.

## Hive Memory Goals

### Product Goals

1. Make a workspace's durable knowledge available to future orchestrator and worker sessions.
2. Let one worker's discovery help another worker later without binding memory to the original worker.
3. Reduce repeated context setup for recurring project work.
4. Improve recovery when native CLI resume fails.
5. Keep memory inspectable and auditable so users can trust what was injected.
6. Keep protocol contracts and state machine logic outside memory.

### Technical Goals

1. SQLite is the source of truth for Hive memory.
2. Memory is primarily scoped to `workspace_id`.
3. User/global memory is optional and separate from workspace memory.
4. Worker/agent identity is source metadata, not the owner.
5. Dispatches and messages are evidence sources, not memory owners.
6. M1 memory writes are explicit or candidate-based before activation. M2 Dream is the explicit exception: offline batch output may auto-apply, but only under workspace toggle, `source: dream`, confidence, lower injection ranking than explicit entries, diff report, and whole-run revert.
7. Memory injection is bounded and source-labeled.
8. Indexing can use FTS first; vector/provider indexing can be added later.
9. All schema changes go through migrations and `schema_version`.
10. Integration tests must use real HTTP server + real SQLite for new protocol behavior.

## Non-Goals

- Do not store PTY transcript bytes as memory input.
- Do not bind memory ownership to worker name, role, role template, or collaboration number.
- Do not add memory fields to `team list`.
- Do not use memory to enforce protocol behavior.
- Do not automatically write every `team report` into active memory.
- Do not silently train memory from MCP/web/private external context without policy, workspace-level enablement, and audit/revert path.
- Do not make memory required for the core Hive protocol to work.

## Recommended Architecture

### Episodic Recall Layer (added 2026-06-07)

Hive already owns a structured, pollution-free record of team collaboration: the `messages` and `dispatches` tables (protocol events, workspace-isolated, attributed — never PTY bytes). An FTS5 index over these plus a `team recall "<query>"` command gives every agent "what did the team do/decide about X" as raw evidence windows (Hermes `session_search` shape: actual rows ± context window, bookends, no LLM summarization). Zero extraction cost, zero curation burden, zero poisoning risk. This is the cheapest layer and ships in the first milestone alongside semantic memory. Use a trigram FTS5 tokenizer alongside unicode61 so CJK queries match (Hermes added this for exactly that reason).

### Ownership Model

Memory owner:

- `workspace_id` for project/team memory.
- `user` or global scope for cross-project preferences.

Memory evidence:

- `dispatch_id`
- `messages.sequence`
- source excerpt
- source text hash
- actor id/name/role snapshot

Memory routing metadata:

- tags
- kind
- confidence
- status
- optional target role hints
- optional target agent snapshot for provenance

Important: no hard foreign key should require a live worker or role template for memory to remain valid.

### Suggested Tables

Draft shape:

```sql
memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  scope TEXT NOT NULL,              -- workspace | user
  kind TEXT NOT NULL,               -- fact | preference | decision | pitfall | procedure_ref
  body TEXT NOT NULL,
  tags TEXT,
  status TEXT NOT NULL,             -- active | candidate | archived | rejected
  source TEXT NOT NULL,             -- manual | dream
  confidence REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  last_injected_at INTEGER
);
```

```sql
memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL,        -- manual | message | dispatch | report | user_confirmed | dream
  source_id TEXT,
  source_sequence INTEGER,
  excerpt TEXT,
  text_hash TEXT,
  actor_agent_id_snapshot TEXT,
  actor_name_snapshot TEXT,
  actor_role_snapshot TEXT,
  created_at INTEGER NOT NULL
);
```

Injection audit should ship with M1, because it is required for user observability and M2 Dream revert/debugging:

```sql
memory_injections (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  workspace_id TEXT,
  target_agent_id_snapshot TEXT,
  context_type TEXT NOT NULL,       -- startup | dispatch | recovery | manual_search
  dispatch_id TEXT,
  injected_at INTEGER NOT NULL
);
```

### Injection Points

1. Startup prompt
   - Inject only pinned workspace memory and a short digest.
   - Keep this small.
   - Label it clearly as Hive memory.

2. Dispatch prompt
   - Most valuable injection point.
   - Retrieve top-K memories relevant to task text, workspace, tags, and target worker role snapshot.
   - Wrap in a clear block such as `<hive-memory>`.
   - Include short source labels.

3. Recovery summary
   - Add bounded memory digest to existing `recovery-summary.ts`.
   - Keep existing `messages + .hive/tasks.md + worker list` recovery facts primary.

4. Manual search
   - Add `team memory search/show` for agents that need more context.
   - Return evidence-backed entries.

Do not inject memory into:

- `team list`
- raw terminal transcript
- every report callback by default

### Commands

Draft CLI surface:

```bash
team recall "<query>" [--limit <n>] [--window <n>]
team memory search "<query>"
team memory show <memory-id>
team memory add "<memory>" [--kind fact|preference|decision|pitfall] [--tag <tag>]
team memory forget <memory-id>
team memory suggest --stdin
```

Suggested policy:

- Orchestrator can search/show/add/forget/suggest.
- Workers can search/show/add.
- Orchestrator-created memory writes become active; worker-created memory writes become candidates unless explicitly allowed.
- Worker `forget` is denied.
- User/UI can approve, edit, archive, or delete.

### UI

Recommended Workspace Memory panel:

- Active / Candidate / Archived tabs.
- Search and tag filters.
- Source evidence view.
- Last injected timestamp.
- Per-memory enable/disable.
- Per-workspace memory feature toggle.
- Show "memory injected into this dispatch" for observability.

### Extraction (revised 2026-06-07)

M1: no automatic writes at all — explicit `team memory add` only (orchestrator → active, worker → candidate).

M2 (dream): offline batch consolidation, auto-applied with post-hoc audit — see Decisions #5 and Milestones M2.

- Reads `user_input`, `send`, and `report` messages plus existing entries — never PTY transcript bytes.
  `status` messages are progress/standby noise for this milestone: they do not trigger the Dream
  threshold and are not included as citable Dream sources.
- Extraction disabled when sensitive external context was used, unless explicitly allowed.
- Provider-backed extraction only after local SQLite behavior is proven.

## Milestones (revised 2026-06-07)

M0: Memory research and pre-spec

- This document, follow-up research, and the direction decisions above.

M1: Team memory v1 — first perceivable milestone

Episodic layer:

- FTS5 index over `messages` (and dispatch `report_text`), unicode61 + trigram tokenizers.
- `team recall "<query>"` returning raw message windows with evidence (sequence, actor snapshots, timestamps).

Semantic layer:

- `memory_entries` + `memory_sources` tables, migration + `schema_version` bump.
- `team memory add/search/show/forget` via new `routes-memory.ts`.
- Write policy: orchestrator add → active; worker add → candidate.

Injection:

- Startup: pinned entries + bounded digest.
- Dispatch: top-K retrieval wrapped in `<hive-memory>` with source labels.
- Recovery: bounded digest added to `recovery-summary.ts` (existing recovery facts stay primary).
- `memory_injections` audit table from day one (needed for dream revert and "what was injected" observability).

Audit:

- One-way export to `<workspace>/.hive/memory.md` (SQLite remains source of truth, no reverse sync).
- Minimal UI: list + candidate approve/reject + delete + per-workspace toggle.

Tests: real HTTP server + real SQLite + `team` CLI request path (no PTY mocks).

M2: Dream — offline batch consolidation

- Trigger: manual button + scheduled/idle background run; never blocks live work.
- Hygiene pass over existing entries: dedupe/merge, absolute-ize relative dates, archive stale (archive, never delete).
- Extraction pass over protocol messages: mine new facts/pitfalls/decisions; new entries activate directly, tagged `source: dream` + confidence, ranked below explicit entries at injection.
- Diff-style dream report per run (added/merged/archived), surfaced in UI and `.hive/memory.md` changelog; one-click revert of a whole run.
- Per-workspace toggle; extraction skipped for windows that used sensitive external context.

M3: Provider bridge

- EverOS/Honcho/Mem0 style provider abstraction.
- SQLite remains source of truth.
- Provider stores/searches derived index or external representations.

## Open Questions

1. Should user/global memory live in the same runtime SQLite DB, or a separate profile DB?
2. Should workspace memory be exported to `<workspace>/.hive/memory.md` for human audit, or kept only in SQLite with UI export? — **Resolved 2026-06-07**: one-way export to `.hive/memory.md`; SQLite stays source of truth.
3. Which agent roles can create active memory directly, if any? — **Resolved 2026-06-07**: orchestrator only; worker writes become candidates.
4. Should worker-scoped candidate memories be auto-archived when the worker is deleted, or remain active with lower ranking?
5. Should Hive memory support expiration by default for "pitfall" and "workflow" entries?
6. Should provider-backed memory be optional per workspace or global?
7. How should memory interact with remote access and mobile clients?

## Review Checklist

Ask the next reviewer to check:

- Whether workspace ownership is the right stable lifecycle boundary.
- Whether the schema avoids hard coupling to deleted workers/roles.
- Whether memory injection could pollute protocol contracts.
- Whether candidate extraction has enough safety and user control.
- Whether this design conflicts with `docs/superpowers/specs/2026-04-18-hive-design.md`.
- Whether first milestone scope is small enough to implement with real integration tests.
