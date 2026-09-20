---
title: Claude Code Workflow System — Comprehensive Reference
purpose: Research + direct-session observations on Anthropic's Workflow tool, Agent SDK, hooks, skills, and multi-agent patterns. Captured 2026-05-29 from a live Claude Code Opus 4.7 session against the Hive private-release repo.
audience: Hive contributors who want to understand the prior art behind Hive's own .hive/workflows/*.ts runtime.
generation: Sections 1-9 + References produced by a 5-agent Workflow run (4 parallel WebSearch/WebFetch researchers + 1 synthesizer). Appendices A and B added by hand from the live tool/prompt surface visible in the session that ran the research.
---

# Claude Code Workflow System: Comprehensive Reference

# 1. Overview

Claude Code's orchestration surface has grown into a layered system: a raw REST client at the bottom, a programmable Agent SDK in the middle, an interactive CLI on top, and a *Dynamic Workflows* runtime that sits beside the CLI as the heaviest orchestration primitive. Around that core, Anthropic ships an extension fabric — hooks, skills, slash commands, MCP servers, subagents, status lines, keybindings, settings, and memory — that determines what an agent can do, when it does it, and how it persists.

This document merges four research findings into a single reference. It covers (1) the Workflow Tool itself and the rules that govern its scripts, (2) the SDK layering and Model Context Protocol surface, (3) the per-component extension files that customize behavior, (4) the multi-agent patterns Anthropic teaches across its essays, (5) the concurrency, budget, and isolation invariants that bound a run, and (6) how the Anthropic stance compares with AutoGen, LangGraph, and CrewAI.

Three temporal anchors orient the rest:

- **December 2024** — "Building Effective Agents" [1] frames the design space as five composable workflow patterns.
- **June 2025** — "How we built our multi-agent research system" [2] documents the orchestrator–worker pattern in production at 15× chat token cost.
- **May 2026** — Dynamic Workflows ship to research preview [3][4] alongside Claude Opus 4.8, moving orchestration out of the model and into a deterministic JavaScript runtime.

The decisive evolution between these milestones is that the loop, the branching, and the intermediate state have migrated out of Claude's context and into code that Claude *writes once and the runtime executes*.

# 2. The Workflow Tool

## 2.1 What a workflow is

A workflow is "a JavaScript script that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive" [4]. Loops, branching, and intermediate results live in script variables, so Claude's own context only sees the final answer [4].

Dynamic workflows shipped to research preview on **2026-05-28** alongside Claude Opus 4.8 and require **Claude Code v2.1.154+**. They are available on Pro/Max/Team/Enterprise plans, on the Anthropic API, and on Bedrock/Vertex/Foundry [3][4][5].

## 2.2 Triggering a workflow

Three ways to spawn one:

1. **Bundled command** — `/deep-research <question>` is the only built-in workflow. It fans out web searches, cross-checks sources, and returns a cited report [4].
2. **Keyword in prompt** — Include the literal word `workflow` anywhere in your prompt; Claude Code highlights it and writes a script instead of working turn-by-turn. `alt+w` ignores a false trigger.
   ```text
   Run a workflow to audit every API endpoint under src/routes/ for missing auth checks
   ```
3. **Ultracode effort level** — `/effort ultracode` combines `xhigh` reasoning effort with automatic workflow orchestration. Claude then plans a workflow for every substantive task in the session. Only available on models that expose the `xhigh` effort level [4].

Saved workflows live in `.claude/workflows/` (project) or `~/.claude/workflows/` (user) and appear as `/<name>` in autocomplete. Save the current run from `/workflows` by pressing `s`.

## 2.3 Workflow DSL

The workflow runtime exposes a small JavaScript surface [6]:

```js
// agent(prompt, opts?) → Promise<string|object>
const summary = await agent("Summarize src/auth/", {
  model: "haiku",
  isolation: "worktree",
  schema: { type: "object", properties: { issues: { type: "array" } } },
  phase: "audit",
  label: "auth-audit",
  stallMs: 180_000,
  agentType: "security-reviewer",
});

// phase("Title") — opens a named progress group in /workflows UI
phase("Phase 1: discover");

// parallel(thunks) — fan-out + barrier; resolves when ALL complete
const results = await parallel(
  files.map(f => () => agent(`Audit ${f}`, { phase: "audit" }))
);

// pipeline(items, ...stages) — streaming chain; no barrier between stages
// stage signature: (prevResult, originalItem, index) => any
const verdicts = await pipeline(
  endpoints,
  (_, ep) => agent(`Find auth for ${ep}`),
  (finding, ep) => agent(`Adversarially review: ${finding} for ${ep}`)
);

// log(message) — narrator line in workflow log
log("Discovered 47 endpoints");

// workflow(nameOrRef, args?) — call a saved workflow inline, sharing
// budget, concurrency cap, and abort signal with the parent
await workflow("/code-review", { branch: "feat/x" });
```

`agent()` opts include `label`, `phase`, `schema` (JSON-Schema-validated structured output), `model` (`haiku|sonnet|opus|inherit|<id>`), `isolation: 'worktree'` for sandboxed file edits, `agentType` for a registered subagent, and `stallMs` (default 180000) to override the stall-timeout.

## 2.4 Globals inside the script

- `args` — input passed to the workflow (object | string | undefined)
- `budget.total` — token target or `null`
- `budget.spent()` — output tokens spent so far in this run
- `budget.remaining()` — `max(0, total − spent())` or `Infinity` when uncapped
- `console.log/.error` — routed into the workflow log

## 2.5 Hard caps and runaway backstop

| Constraint | Value | Behavior on breach |
|---|---|---|
| `agent()` calls per run | **1,000** | Throws `WorkflowAgentCapError` |
| Concurrent agents | **`min(16, max(2, cores−2))`** | Excess queued |
| Script size | 524 KB | Rejected before parsing |
| Per-agent stall | 180 s | Aborts, retries up to 5×, then abandons |
| Sync loop timeout | 30 s | Catches infinite synchronous loops |

Banned in the orchestrator (non-determinism kills resume-cache): `Math.random()`, `Date.now()`, unparameterized `new Date()`, fs/Node APIs. Vary by index instead; pass timestamps via `args` [4][6].

## 2.6 Token budget directives

The runtime understands inline directives like `+500k` in the script that bump the run's token budget ceiling. The script reads its remaining headroom via `budget.remaining()`. Anthropic explicitly warns: "Dynamic workflows can consume substantially more tokens than a typical Claude Code session" [3]. Workflows count toward your plan's usage and rate limits like any other session.

## 2.7 Workflow vs subagent vs skill

| Approach | Plan held by | Scale | Resumable | When to use |
|---|---|---|---|---|
| **Subagents** (Agent tool) | Claude, turn-by-turn | Few per turn | Restarts the turn | Side task that would flood main context |
| **Skills** | Claude, following prompt | Same as subagents | Restarts the turn | Reusable instructions |
| **Workflows** | The script | Dozens-hundreds | Yes (same session) | Audits, 500-file migrations, cross-checked research |
| **Agent view** (`claude agents`) | You | Many independent sessions | Survives restart | Hand off independent tasks |
| **Agent teams** | Lead Claude session | Coordinated workers w/ shared task list | Yes | Experimental; disabled by default |

The decisive trade-off: subagents put every result back into Claude's context (cheap, but burns parent context); workflows keep intermediate results in script variables (only the final answer lands in Claude's context, at the cost of writing a script Claude can't iteratively refine mid-run). Subagents cannot be spawned by subagents — workflows replace that need [7].

`/agents` opens the subagent panel (Running + Library tabs); `/workflows` lists workflow runs; `claude agents` opens agent view.

## 2.8 Background execution model

Two distinct background systems coexist [8]:

**Background bash tasks** — When Claude runs a command in the background (or you press **Ctrl+B**), it "runs the command asynchronously and immediately returns a background task ID." Output streams to a file Claude reads with `Read`. Tasks auto-terminate at 5 GB of output. Listed with `/tasks` or `/bashes`. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` to disable entirely.

**Background subagents/workflows** — Workflows always run in the background; subagents can be foreground or background (the `background: true` frontmatter field forces always-background). Press **Ctrl+B** to background a running subagent, or **Ctrl+X Ctrl+K** (twice within 3 s) to kill all background subagents.

Workflow runs surface in:
- `/workflows` — full progress view: arrow keys to navigate, `Enter` to drill in, `p` pause/resume, `x` stop, `r` restart agent, `s` save script
- The task panel below the input box (one-line progress; ↓ to focus, Enter to expand)

**Journal & resume.** Each subagent's transcript persists at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl` [7]. Workflows are resumable **within the same session**: completed agents return cached results, the rest run live. Exiting Claude Code while a workflow runs forces a fresh start on next launch.

The deterministic-only orchestrator (no `Math.random`/`Date.now`) is what makes resume-caching possible: the same script always produces the same agent-call key sequence, so cached results match.

# 3. Agent SDK & MCP

## 3.1 The three SDK packages

Anthropic ships **three distinct npm/PyPI packages**, each at a different layer of abstraction [9]:

| Package | Layer | What you get |
|---|---|---|
| `@anthropic-ai/sdk` (TS) / `anthropic` (Python) | Raw REST client | Just `client.messages.create({...})`. **You** implement the tool-execution loop. |
| `@anthropic-ai/claude-code` | CLI binary | The interactive `claude` shell — terminal UI, REPL, slash commands. |
| `@anthropic-ai/claude-agent-sdk` (TS) / `claude-agent-sdk` (Python) | Programmatic agent harness | The same engine that powers Claude Code, exposed as `query()` — owns the entire agent loop, tools, sessions, hooks, MCP, subagents. |

The Claude Code SDK was **renamed to the Claude Agent SDK in late 2025**. The TypeScript SDK bundles a native Claude Code binary as an optional dependency, so you do **not** need to install Claude Code separately [9].

The official docs draw the line bluntly: "With the Client SDK, you implement a tool loop. With the Agent SDK, Claude handles it."

```ts
// Client SDK (raw): you run the loop
let response = await client.messages.create({ ...params });
while (response.stop_reason === "tool_use") {
  const result = yourToolExecutor(response.tool_use);
  response = await client.messages.create({ tool_result: result, ...params });
}

// Agent SDK: Claude owns the loop
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const message of query({ prompt: "Fix the bug in auth.ts" })) {
  console.log(message);
}
```

Starting **June 15, 2026**, Agent SDK and `claude -p` usage on subscription plans draws from a separate monthly Agent SDK credit ($20/month on Pro, $200/month on Max 20x) [9].

## 3.2 Embedding Claude programmatically

The Agent SDK's single entry point is `query()`. It returns an **async iterator of `SDKMessage` events** — system init, assistant text/tool_use blocks, user tool_result blocks, and a final result message [9]:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find all TODO comments and create a summary",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],     // pre-approve safe tools
    permissionMode: "acceptEdits",              // or "default" / "bypassPermissions" / "plan"
    model: "sonnet",                            // alias or full ID
    cwd: "/path/to/project",
    settingSources: ["project", "user"],        // load .claude/ + ~/.claude/
    maxTurns: 20,
    resume: previousSessionId,                  // optional: continue a session
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [logFileChange] }]
    }
  }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;   // capture for later resume
  }
  if ("result" in message) console.log(message.result);
}
```

A fourth option exists: **Managed Agents** — a hosted REST API where Anthropic runs the agent and sandbox; you post events and stream results back. The common path is "prototype with the Agent SDK locally, then move to Managed Agents for production."

## 3.3 Custom subagent definitions

Subagents are spawned via the built-in `Agent` tool (renamed from `Task` in Claude Code v2.1.63 — both names still appear depending on SDK version [7]). They run in **fresh, isolated context windows**; only the final message returns to the parent. There are **three ways to define them**, with precedence: managed settings > `--agents` JSON > `.claude/agents/` (project) > `~/.claude/agents/` (user) > plugin agents [10].

### Filesystem format

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices. Use proactively after code changes.
tools: Read, Glob, Grep
disallowedTools: Write, Edit
model: sonnet
permissionMode: default
maxTurns: 15
skills: [secure-coding, perf-audit]
mcpServers: [github, postgres]
memory: project
isolation: worktree
color: blue
---

You are a code review specialist. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

The complete supported frontmatter set: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt`. Only `name` and `description` are required. The Markdown body becomes the system prompt; subagents receive only this plus minimal env (no parent system prompt or conversation history) [7].

Claude scans `.claude/agents/` and `~/.claude/agents/` **recursively** and picks subagents by **matching the user's request against the `description` field** — so the description's wording is functionally part of the routing logic.

### Programmatic definition

```ts
for await (const message of query({
  prompt: "Review the auth module for security issues",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Agent"],  // Agent must be allowed
    agents: {
      "code-reviewer": {
        description: "Expert reviewer for security and quality.",
        prompt: "You are a code review specialist...",
        tools: ["Read", "Grep", "Glob"],
        model: "sonnet"
      },
      "test-runner": {
        description: "Runs and analyzes test suites.",
        prompt: "You are a test execution specialist...",
        tools: ["Bash", "Read", "Grep"]
      }
    }
  }
}));
```

Critical gotchas:
- You **must** include `"Agent"` in `allowedTools` or every subagent invocation triggers a permission prompt.
- **Subagents cannot spawn their own subagents.** Don't include `Agent` in a subagent's `tools`.
- Messages from inside a subagent carry `parent_tool_use_id` — that's how you attribute streamed output to the right subagent in a UI.
- Programmatic definitions **override** filesystem agents with the same name [10].

### Built-in subagents

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| **Explore** | Haiku | Read-only (no Write/Edit) | Codebase search; `quick` / `medium` / `very thorough`; skips CLAUDE.md and git status |
| **Plan** | Inherits | Read-only | Plan-mode research; skips CLAUDE.md/git status; prevents infinite nesting |
| **general-purpose** | Inherits | All | Multi-step tasks needing exploration + modification |
| **statusline-setup** | Sonnet | Configuration | Auto-invoked by `/statusline` |
| **claude-code-guide** | Haiku | Doc tools | Answers questions about Claude Code itself |

## 3.4 MCP (Model Context Protocol)

MCP is the open standard that lets a server expose tools, resources, and prompts that any compliant client (Claude Code, Cursor, VS Code, Claude Desktop) can consume [11]. The Agent SDK supports **three transports**:

| Transport | When | Config |
|---|---|---|
| **stdio** | Local subprocess | `{ command: "npx", args: [...], env: {...} }` |
| **HTTP / SSE** | Remote / cloud | `{ type: "http", url: "...", headers: {...} }` |
| **SDK MCP server** | In-process | Define tools as TS/Python functions, no separate process |

```ts
for await (const m of query({
  prompt: "List the 3 most recent issues in anthropics/claude-code",
  options: {
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
      }
    },
    allowedTools: ["mcp__github__*"]   // wildcard auto-approve
  }
})) { /* ... */ }
```

**Tool discovery and deferral.** MCP tools follow `mcp__<server>__<tool>` naming. By default, **Tool Search is enabled** — MCP tool *definitions* are NOT loaded into context at session start. Only tool names register; Claude calls a special `ToolSearch` tool to discover relevant tools when a task needs them. This keeps context small even with dozens of MCP servers connected.

Configuration knobs (`ENABLE_TOOL_SEARCH`):
- unset / `true` → all MCP tools deferred (default)
- `auto` → load upfront if they fit within 10% of context, else defer
- `auto:N` → custom percentage threshold
- `false` → load all tools upfront

For tools that should always be visible, set `alwaysLoad: true` on the server entry, or set `"anthropic/alwaysLoad": true` in a tool's `_meta`.

**Dynamic updates.** Servers can send MCP `list_changed` notifications and Claude Code refreshes capabilities without reconnect. HTTP/SSE servers auto-reconnect with exponential backoff (5 attempts) [11].

**Resources and prompts.** MCP servers expose **resources** referenceable as `@server:protocol://path` in prompts — they appear in `@`-mention autocomplete and are fetched as attachments. **Prompts** become commands: `/mcp__server__promptname [args]`.

**Self-hosted MCP.** `claude mcp serve` turns Claude Code itself into an MCP server, exposing its Read/Edit/LS/Bash tools to any other MCP client.

## 3.5 Tool-use protocol and structured output

At the **raw API layer**, tool use is a stop-reason loop:

1. You send `messages.create({ tools: [{ name, description, input_schema }], messages })`.
2. Claude returns `stop_reason: "tool_use"` with one or more `tool_use` content blocks: `{ id, name, input }`.
3. You execute the tool and send a `user` message containing a `tool_result` block: `{ type: "tool_result", tool_use_id, content }`.
4. Repeat until `stop_reason: "end_turn"`.

The Agent SDK runs this loop for you and surfaces each tool_use / tool_result as a streamed message.

**Structured output** has historically been "abuse the tool-use protocol" — define a tool whose `input_schema` is your target JSON schema, force it with `tool_choice: { type: "tool", name: "..." }`, and read `tool_use.input` as your typed object.

In **late 2025 Anthropic shipped native Structured Outputs (beta)**: send the header `anthropic-beta: structured-outputs-2025-11-13` and an `output_format` parameter with your JSON schema. The model uses **constrained decoding** (compiling the schema into a grammar that restricts token generation), giving mathematical guarantees that the response matches the schema. Available on Claude Sonnet 4.5 and Opus 4.1+ [12].

## 3.6 Prompt caching

Prompt caching is **essential** for any long-running agent because the system prompt + tool definitions + accumulated history get re-sent on every turn [13].

You mark cacheable prefixes with `cache_control: { type: "ephemeral" }` on a content block. Up to **4 breakpoints per request**. The API checks for cache hits at all block boundaries up to ~20 blocks before your breakpoint. Pricing: **cache hits = 10% of base input**, **cache writes = 25% premium**, default TTL 5 minutes (extendable to 1 hour with `ttl: "1h"`).

```ts
const response = await client.messages.create({
  model: "claude-sonnet-4-5",
  system: [
    { type: "text", text: "You are a code reviewer..." },
    { type: "text", text: LARGE_KNOWLEDGE_BASE, cache_control: { type: "ephemeral" } }
  ],
  tools: [...tools],  // tools can also carry cache_control
  messages: [
    ...priorTurns,  // these accumulate
    { role: "user", content: [{ type: "text", text: nextTurn, cache_control: { type: "ephemeral" } }] }
  ]
});
```

Place a `cache_control` breakpoint on the **last user message**. As the conversation grows, the cache breakpoint effectively moves forward. On a 10K-token system prompt this typically yields **5–10× cost reduction on input** plus ~85ms latency savings on the cached prefix [13]. The Agent SDK enables caching automatically on its internal loop.

# 4. Hooks, Skills, Commands, and Memory

## 4.1 Hooks

Hooks are shell-level callbacks Claude Code fires at fixed points in its lifecycle. They live under the `hooks` key of any `settings.json` and run deterministically — unlike CLAUDE.md guidance, a hook *can* block tool execution [14].

### Cadences and event taxonomy

Claude Code defines ~30 hook events grouped into three cadences plus async events:

- **Once per session**: `SessionStart` (matchers: `startup`, `resume`, `clear`, `compact`), `SessionEnd`, `Setup` (matchers: `init`, `maintenance`)
- **Once per turn**: `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`
- **Per tool call**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `PostToolBatch`
- **Async/lifecycle**: `Notification`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PreCompact`, `PostCompact`, `FileChanged`, `CwdChanged`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `MessageDisplay`, `Elicitation`, `ElicitationResult`, `TeammateIdle`

### Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/check.sh",
            "timeout": 30,
            "statusMessage": "Validating..."
          }
        ]
      }
    ]
  }
}
```

Matcher rules: `"*"` or omitted matches all; bare letters/digits/`|` are exact or OR-list (`Bash|Edit`); anything else is treated as a JS regex (`mcp__memory__.*`). `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_DATA}` are valid path placeholders.

Handler `type` values: `command` (most common — stdin gets JSON, stdout/stderr drive behavior), `http`, `mcp_tool`, `prompt`, `agent`.

### JSON input contract

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/build" }
}
```

### Exit codes and JSON output

| Exit code | Behavior |
|---|---|
| 0 | Stdout JSON is parsed; plain stdout is added to transcript |
| 2 | **Blocking error** — stderr is fed back to Claude; tool is blocked |
| other | Non-blocking; stderr shown to user; execution continues |

Universal output keys: `continue` (false stops Claude entirely), `stopReason`, `suppressOutput`, `systemMessage`, plus event-specific `hookSpecificOutput`. Example PreToolUse blocker:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "rm -rf detected",
    "modifiedToolInput": { "command": "ls /tmp/build" }
  }
}
```

Defaults: `command/http/mcp_tool` = 600s (30s on `UserPromptSubmit`), `prompt` = 30s, `agent` = 60s. The `/hooks` slash command lists every configured hook across all layers with source, matcher, and command. `disableAllHooks: true` shuts everything off (except managed hooks unless set at the managed layer) [14][15].

## 4.2 Skills

Skills are markdown files Claude loads on demand. They replace the old `~/.claude/commands/` system (which still works as a thin compatibility layer) and follow the open Agent Skills spec [16].

| Scope | Path |
|---|---|
| Enterprise | Via managed settings |
| Personal | `~/.claude/skills/<name>/SKILL.md` |
| Project | `.claude/skills/<name>/SKILL.md` |
| Plugin | `<plugin>/skills/<name>/SKILL.md` → invoked as `/plugin-name:name` |

The command name comes from the **directory** name. Enterprise > personal > project on name conflicts; a same-named skill always beats a same-named `.claude/commands/*.md` file.

### SKILL.md frontmatter

```yaml
---
name: pr-summary                          # display label only
description: Summarize a PR; use when reviewing diffs.
when_to_use: When user asks about PR scope or commit message.
argument-hint: "[pr-number]"
arguments: [pr]                            # named positional; enables $pr substitution
disable-model-invocation: false            # true = user-only (/-invoke)
user-invocable: true                       # false = Claude-only (background context)
allowed-tools: Bash(gh *) Read Grep        # pre-approved while skill active
disallowed-tools: AskUserQuestion
model: inherit                             # or sonnet|opus|haiku
effort: high                               # low|medium|high|xhigh|max
context: fork                              # run in isolated subagent
agent: Explore                             # which subagent type when forking
paths: ["src/**/*.ts"]                     # only auto-trigger when matching files open
hooks:                                     # skill-scoped hooks
  PreToolUse:
    - matcher: Bash
      hooks:
        - { type: command, command: "./check.sh" }
shell: bash                                # or powershell
---
```

`description + when_to_use` is truncated at **1,536 chars** in the skill listing. The full SKILL.md body only enters context **when invoked**. Skill *descriptions* are always loaded so Claude knows what's available. Override states with `skillOverrides` in settings: `"on" | "name-only" | "user-invocable-only" | "off"`.

Keep body under 500 lines; spill detail into sibling files (`reference.md`, `examples/`, `scripts/helper.py`). After auto-compaction, the most recent invocation of each skill is re-attached (first 5,000 tokens each, 25,000-token combined budget).

### Argument substitution

`$ARGUMENTS` (full string), `$ARGUMENTS[N]` or `$N` (0-indexed), `$pr` (named via `arguments:`), `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`.

### Dynamic context injection

A line starting with `` !`<command>` `` runs *before* Claude sees the skill; output replaces the placeholder:

```yaml
---
description: Summarize the working diff.
---
## Diff
!`git diff HEAD`

## Task
Summarize the changes and flag risks.
```

Disabled per-policy with `"disableSkillShellExecution": true` (bundled/managed skills exempt).

### Skills vs commands vs MCP

- **Slash command** (`.claude/commands/foo.md`): a single markdown file; same frontmatter; Claude can't auto-invoke unless promoted to a skill.
- **Skill** (`.claude/skills/foo/SKILL.md`): directory-based; supports bundled scripts/templates; can be auto-invoked by Claude based on `description`; can fork to a subagent.
- **MCP server**: external process exposing tools/resources/prompts over JSON-RPC; lives in `mcpServers` config; tools enter the tool palette without markdown bodies.

## 4.3 Slash commands

Three categories [17]:

### Built-in (CLI-implemented)

`/help`, `/clear` (alias `/reset`, `/new`), `/model`, `/config` (alias `/settings`), `/permissions`, `/memory`, `/statusline`, `/keybindings`, `/skills`, `/hooks`, `/agents`, `/mcp`, `/plugin`, `/init`, `/review`, `/security-review`, `/compact`, `/context`, `/effort`, `/plan`, `/doctor`, `/usage` (aliases `/cost`, `/stats`), `/resume`, `/rewind`, `/branch`, `/diff`, `/copy`, `/export`, `/rename`, `/add-dir`, `/theme`, `/tui`, `/login`, `/logout`, `/feedback`, `/fast`, `/btw`, `/goal`, `/sandbox`, `/voice`, `/teleport`, `/remote-control`, `/background`, `/tasks`, `/exit`.

### Bundled skills (prompt-driven, can also auto-invoke)

`/code-review`, `/simplify`, `/batch`, `/debug`, `/loop` (alias `/proactive`), `/run`, `/verify`, `/run-skill-generator`, `/claude-api`, `/fewer-permission-prompts`. Plus **Workflows** like `/deep-research`. The Skill tool can invoke `/init`, `/review`, `/security-review` but **not** `/compact`.

### User-defined

A file at `~/.claude/commands/deploy.md` creates `/deploy`. The skill-equivalent path `.claude/skills/deploy/SKILL.md` wins on name conflicts. Subdirectories namespace: `.claude/commands/git/commit.md` → `/git:commit`.

```markdown
---
description: Fix a GitHub issue
argument-hint: "[issue-number] [priority]"
allowed-tools: Bash(gh issue view *) Edit
---
Fix GitHub issue #$1 with priority $2.
Run `gh issue view $1` first, then implement the fix.
```

## 4.4 Status line

The status line is a shell script Claude runs after each assistant message, after `/compact`, on permission-mode change, and on vim-mode toggle (debounced 300 ms). It does **not** consume API tokens [18]:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 2,
    "refreshInterval": 5,
    "hideVimModeIndicator": false
  }
}
```

`refreshInterval` re-runs the command every N seconds (≥1). The script reads JSON from stdin:

```json
{
  "model": { "id": "claude-opus-4-8", "display_name": "Opus" },
  "workspace": { "current_dir": "...", "project_dir": "...", "git_worktree": "feature-x",
                 "repo": { "host": "github.com", "owner": "anthropics", "name": "claude-code" } },
  "cost": { "total_cost_usd": 0.012, "total_duration_ms": 45000,
            "total_lines_added": 156, "total_lines_removed": 23 },
  "context_window": { "total_input_tokens": 15500, "context_window_size": 200000,
                      "used_percentage": 8, "current_usage": { "cache_read_input_tokens": 2000 } },
  "exceeds_200k_tokens": false,
  "effort": { "level": "high" },
  "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 } },
  "session_id": "...", "transcript_path": "...", "version": "2.1.90",
  "pr": { "number": 1234, "url": "...", "review_state": "pending" },
  "vim": { "mode": "NORMAL" },
  "worktree": { "name": "...", "path": "...", "branch": "..." }
}
```

The script prints to stdout (multi-line allowed); ANSI color codes work; OSC 8 makes clickable links. The terminal width is in env vars `COLUMNS` / `LINES` (since v2.1.153).

## 4.5 Keybindings

Requires v2.1.18+. Run `/keybindings` to open `~/.claude/keybindings.json`. Edits are hot-reloaded [19].

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+e": "chat:externalEditor",
        "ctrl+k ctrl+t": "chat:thinkingToggle",
        "shift+enter": "chat:newline",
        "ctrl+u": null
      }
    }
  ]
}
```

**Contexts**: `Global`, `Chat`, `Autocomplete`, `Settings`, `Confirmation`, `Tabs`, `Help`, `Transcript`, `HistorySearch`, `Task`, `ThemePicker`, `Attachments`, `Footer`, `MessageSelector`, `DiffDialog`, `ModelPicker`, `Select`, `Plugin`, `Scroll`, `Doctor`.

**Actions** are `namespace:action` (`chat:submit`, `app:toggleTodos`, `history:search`, `confirm:yes`, etc.).

**Syntax**: modifiers `ctrl|shift|alt|opt|meta|cmd` joined with `+`; chords are space-separated (`ctrl+k ctrl+s`); set to `null` to unbind.

**Reserved** (cannot rebind): `Ctrl+C`, `Ctrl+D`, `Ctrl+M`, Caps Lock. Common multiplexer collisions: `Ctrl+B` (tmux), `Ctrl+A` (screen), `Ctrl+Z` (SIGTSTP).

## 4.6 Settings hierarchy and permissions

Five layers, highest priority first [20]:

1. **Managed policy** — `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux), `C:\Program Files\ClaudeCode\managed-settings.json` (Windows). Deployed via MDM.
2. **CLI flags** (`--settings`, `--model`, `--add-dir`, etc.)
3. **Project local** — `.claude/settings.local.json` (gitignored automatically)
4. **Project** — `.claude/settings.json` (committed)
5. **User** — `~/.claude/settings.json`

**Merging rule**: scalars (model, theme) override across layers; **arrays merge and dedupe** — including `permissions.allow|deny|ask`, `hooks`, `permissions.additionalDirectories`, `claudeMdExcludes`. A project's `deny` rule never gets erased by a user's `allow` rule — deny is always evaluated first regardless of scope.

### Permissions object

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test *)",
      "Read(~/.zshrc)",
      "WebFetch(domain:github.com)",
      "Skill(commit)"
    ],
    "ask":  [ "Bash(git push *)" ],
    "deny": [ "Bash(curl *)", "Read(./.env)", "Read(./secrets/**)" ],
    "additionalDirectories": ["../shared/"],
    "defaultMode": "acceptEdits"
  },
  "allowManagedPermissionRulesOnly": false,
  "disableBypassPermissionsMode": "disable"
}
```

Rule specifiers: `Tool` (any invocation), `Tool(pattern)` with `*` wildcards, file globs in `Read(...)`, `WebFetch(domain:example.com)`, `Skill(name)` / `Skill(name *)`. Order: deny → ask → allow, first match wins.

## 4.7 Memory

Two complementary systems load at every session start [21].

### CLAUDE.md (you write)

| Scope | Location |
|---|---|
| Managed | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux), `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows), or inline via `claudeMd` key in managed settings |
| User | `~/.claude/CLAUDE.md` |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` |
| Local | `./CLAUDE.local.md` (gitignored) |

Claude walks the directory tree from cwd up to root, concatenating every `CLAUDE.md` it finds; files in subdirectories load **on demand**. Imports use `@path/to/file` syntax (max 4 hops). Block-level HTML comments (`<!-- ... -->`) are stripped before injection. Target ≤200 lines per file.

`AGENTS.md` is **not** read by Claude — but a one-line CLAUDE.md containing `@AGENTS.md` (or a symlink) wires them up.

### .claude/rules/ (path-scoped)

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "lib/**/*.{ts,tsx}"
---
# API rules
- All endpoints must validate input.
```

Rules without `paths` load every session at the same priority as `.claude/CLAUDE.md`.

### Auto memory (Claude writes)

Requires v2.1.59+. Stored at `~/.claude/projects/<project>/memory/`. Override with `autoMemoryDirectory` in **user or managed** settings only (rejected in project settings).

```
~/.claude/projects/<project>/memory/
├── MEMORY.md          # index — first 200 lines / 25KB loaded every session
├── debugging.md       # topic file, loaded on demand
├── api-conventions.md
└── ...
```

Toggle: `autoMemoryEnabled: false` or env var `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. After `/compact`, the project-root CLAUDE.md is re-injected automatically.

## 4.8 Scheduled loops and cron

Scheduled tasks require **v2.1.72+** [22]. Five primitive tools sit under the hood:

| Tool | Purpose |
|---|---|
| `CronCreate` | Schedule a task. Args: 5-field cron, prompt, recurring flag. Returns 8-char ID. |
| `CronList` | List scheduled tasks with IDs, schedules, prompts. |
| `CronDelete` | Cancel by ID. |
| `ScheduleWakeup` | One-shot wake. **No cancel API** [23]. |
| `Monitor` | Run a background script and stream each output line back as a notification. |

Surface skills:

- **`/loop [interval] [prompt]`** — `/loop 5m check the deploy` (fixed); `/loop check CI` (Claude picks 1–60 min); `/loop` alone runs the built-in maintenance prompt. Esc stops a pending wakeup. Intervals: `s/m/h/d`; sub-minute rounded up.
- **`/schedule`** — manages persistent **Routines** in Anthropic's cloud.

Limits: max **50** scheduled tasks per session; recurring tasks **auto-expire after 7 days**; all times in local TZ. **Jitter**: recurring fires up to 30 min late; one-shots on `:00`/`:30` fire up to 90 s early. No catch-up for missed fires. `CLAUDE_CODE_DISABLE_CRON=1` kills the scheduler.

# 5. Multi-Agent Patterns

## 5.1 The five foundational workflow patterns

Anthropic's [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) essay [1] frames the design space as five composable workflows.

**Prompt chaining** — fixed decomposition, gate-checked between steps.
```text
out1 = LLM(input, task1)
assert gate(out1)            # programmatic validation
out2 = LLM(out1, task2)
return out2
```

**Routing** — classify, then dispatch.
```text
cat = LLM(input, classify)
return handlers[cat](input)
```
Used for both *capability* routing (refund vs. technical) and *cost* routing (Haiku for easy, Sonnet/Opus for hard).

**Parallelization** — two flavors: *sectioning* divides work into independent subtasks and aggregates; *voting* runs the same task N ways and thresholds.
```text
# voting
votes = [LLM(input, variant_i) for variant_i in variants]
return decide(votes, threshold=2/3)
```

**Orchestrator–workers** — for tasks where the *subtask shape* is itself unknowable up-front. A lead model plans, spawns workers, and synthesizes.

**Evaluator–optimizer** — generate, evaluate, refine until "good enough." Becomes adversarial verification in later writeups.

## 5.2 Orchestrator–worker in production

[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) [2] is the definitive case study. A lead Claude Opus 4 analyzes the query, plans, and spawns 3–5 Sonnet 4 subagents. Each subagent issues 3+ tool calls in parallel. The system "outperformed a single-agent setup by more than 90 percent" but costs roughly **15× the tokens** of a chat interaction.

Patterns Anthropic explicitly codifies:

- **Effort scaling embedded in the orchestrator prompt** — fleet size by complexity: simple fact-finding → 1 agent, 3–10 tool calls; direct comparison → 2–4 subagents, 10–15 calls each; complex research → 10+ subagents.
- **"Teach delegation" prompting** — each subagent must receive *an objective, an output format, tool guidance, and clear task boundaries*. Vague directives cause subagents to duplicate work.
- **Think-like-your-agents simulations** — look for the agent "continuing when it already had sufficient results." Most failures are over-stepping.
- **LLM-as-judge with a rubric** — a single-call judge scoring 0–1 along factual accuracy, citation accuracy, completeness, source quality, and tool efficiency.
- **End-state evaluation for stateful tasks** — when an agent mutates persistent state, score the final state, not every intermediate step.
- **Filesystem as side channel** — subagents write artifacts the lead reads selectively, dodging context bloat.
- **The 80% number** — "Token usage by itself explains 80% of the variance" in BrowseComp performance.
- **Synchronous bottleneck** — the lead executes subagents synchronously. Async was flagged as future work.

## 5.3 Workflow-runtime patterns

The community-maintained [workflow-creator skill](https://github.com/ray-amjad/claude-code-workflow-creator) [6] catalogs eight named patterns.

### Fan-out then synthesize (legitimate barrier)
```js
phase('Research')
const findings = await parallel(
  questions.map((q, i) => () =>
    agent(`Research and report verified facts:\n\n${q}`,
          { label: `q${i+1}`, schema: RESEARCH_SCHEMA })))
phase('Synthesize')
return agent('Combine into one briefing; call out disagreements.\n\n'
             + JSON.stringify(findings.filter(Boolean), null, 2))
```

### Pipeline (the default multi-stage shape)
Items flow through ordered stages; each item advances the moment *it* is ready. The docs are emphatic: "Prefer it over two `parallel()` calls with a barrier between them."
```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review',  schema: FINDINGS_SCHEMA }),
  review => parallel((review?.findings ?? []).map(f => () =>
    agent(`Adversarially verify: ${f.title}`,
          { phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v })))))
```

### Loop until target / budget / dry
```js
// Target count
while (bugs.length < 10) { ... }

// Budget-aware — the `budget.total &&` guard is essential;
// without a target, remaining() is Infinity and you sprint into the 1000-agent cap.
while (budget.total && budget.remaining() > 50_000) {
  const r = await agent('Find one more issue.', { schema: ISSUE_SCHEMA })
  issues.push(...r.issues)
  log(`${issues.length} found · ${Math.round(budget.remaining()/1000)}k left`)
}

// Loop until dry — keep spawning finders until K consecutive rounds find nothing new
let dryRounds = 0
while (dryRounds < 2 && found.length < 100) {
  const r = await agent('Find issues NOT in this list:\n' + [...seen].join('\n'),
                        { schema: ISSUE_SCHEMA })
  const fresh = r.issues.filter(x => !seen.has(x.id))
  fresh.forEach(x => { seen.add(x.id); found.push(x) })
  dryRounds = fresh.length === 0 ? dryRounds + 1 : 0
}
```

### Adversarial verification (skeptic vote)
```js
async function survives(claim) {
  const votes = await parallel(Array.from({ length: 3 }, (_, i) => () =>
    agent(`Try hard to REFUTE this claim. Default to refuted=true if uncertain.\n\n${claim}`,
          { schema: VERDICT_SCHEMA })))
  return votes.filter(Boolean).filter(v => !v.refuted).length >= 2
}
```
The asymmetric prompt ("default to refuted=true if uncertain") is what stops confident hallucinations from surviving.

### Judge panel
```js
const ANGLES = ['MVP-first', 'risk-first', 'user-first', 'cost-first']
const drafts = await parallel(ANGLES.map(a => () =>
  agent(`Produce a plan for: ${idea}. Take a strictly ${a} approach.`)))
const scored = await parallel(drafts.filter(Boolean).map((d, i) => () =>
  agent(`Score 1-10 for feasibility/impact. Return {score, why}.\n\n${d}`,
        { schema: SCORE_SCHEMA }).then(s => ({ draft: d, ...s }))))
const ranked = scored.filter(Boolean).sort((a, b) => b.score - a.score)
return agent('Write definitive plan from WINNER, grafting runners-up.\n\n'
             + 'WINNER:\n' + ranked[0].draft
             + '\nRUNNERS-UP:\n' + ranked.slice(1).map(r => r.draft).join('\n---\n'))
```

## 5.4 Pipeline-vs-parallel decision

The barrier (`parallel()`) is justified **only** when one of these holds:

1. **Dedup/merge across the full set** — e.g., collating findings by file+line before verifying.
2. **Early-exit on a count** — if `deduped.length === 0`, skip verification entirely.
3. **Cross-item comparison** — judging requires seeing all candidates.

Otherwise, pipeline. On a 50-item review with 10s/30s stages, the unjustified barrier is the difference between a 40-second run and a 20-minute one when one item is slow.

## 5.5 Real-world Anthropic examples

- **Multi-agent Research** [2] — orchestrator–workers + parallel tool use + LLM-judge eval. 90% better on complex queries; 15× token cost.
- **C compiler in two weeks** [24] — 16 parallel containerized Claudes, lockfile coordination, GCC-as-oracle differential testing. 99% test pass; compiled Linux 6.9. ~$20K total (2,000 sessions, 2B input tokens, 140M output tokens).
- **Bun port from Zig to Rust** [3] — hundreds of agents in parallel, 750,000 lines of Rust, 99.8% test pass, **11 days**.
- **`/deep-research` bundled workflow** — fans out web searches across angles, fetches and cross-checks sources, *votes on each claim*, and "claims that didn't survive cross-checking are filtered out" before the report lands.

# 6. Concurrency, Budget, and Isolation

## 6.1 Concurrency caps

The runtime enforces a hard ceiling per workflow run [3][4]:

- 1,000 lifetime `agent()` calls — exceeding throws `WorkflowAgentCapError`.
- `min(16, max(2, cores − 2))` concurrent agents; excess queued.
- 524 KB script size cap.
- 180 s per-agent stall (5 retries then abandon).
- 30 s sync-loop timeout.

In-flight agents finish when a cap is hit; no *new* agents start. This is the "no-silent-caps" invariant.

## 6.2 Budget management as a first-class API

Three concentric controls Anthropic teaches:

1. **Orchestrator effort-scaling prompt** [2] — embed fleet-size rules so the lead picks 1 vs 4 vs 10 subagents based on query complexity.
2. **The `budget` global in workflows** — `{ total, spent(), remaining() }`. Loops self-terminate when `remaining()` falls below a threshold. The pool is **shared across the main loop *and* all workflows in the turn**, not per-workflow.
3. **Hard caps at the runtime level** (above).

Pricing realities, from [2]: agents use **~4× tokens of chat**, multi-agent systems **~15×**. Anthropic teaches the budget mechanism because the answer to "how much fleet?" is now "what did the user authorize?" — not a per-task heuristic.

## 6.3 Isolation layers

Three boundaries, layered:

**Context-window isolation is free and always on.** Every `agent()` spawns a fresh context. The orchestrator never inherits subagent transcripts — only their typed return value. This is what makes 1000-call fan-outs viable without context collapse.

**Worktree isolation is opt-in and costs 200–500ms + disk per agent** [25]. Configure via:

```bash
claude --worktree feature-auth      # creates .claude/worktrees/feature-auth/
claude --worktree                    # generates a name like bright-running-fox
claude --worktree "#1234"            # branch from PR #1234 (fetches pull/1234/head)
```

Default base: `origin/HEAD` for a clean tree from the remote. Override per-project with `worktree.baseRef: "head"` to carry unpushed work. Configure `WorktreeCreate` / `WorktreeRemove` hooks for SVN/Perforce/Mercurial.

Per-subagent via frontmatter:

```yaml
---
name: parallel-coder
description: ...
isolation: worktree
---
```

Or per-`agent()` with `{ isolation: "worktree" }`. Each subagent worktree is temp; auto-removed when the subagent finishes with no changes. The `/batch` skill splits one change into 5–30 worktree-isolated PR-producing subagents. `.worktreeinclude` (gitignore syntax) copies otherwise-gitignored files like `.env` into each new worktree. In-session, Claude can call `EnterWorktree` / `ExitWorktree` mid-conversation.

The [C compiler post](https://www.anthropic.com/engineering/building-c-compiler) [24] is the canonical worked example: 16 agents in isolated Docker containers, each with `/workspace` mounted, coordinated through **file-based task locks** (`current_tasks/<task>.txt`) so git's native synchronization prevents duplicate assignments. Agents pulled upstream, merged conflicts autonomously, and pushed back. No central orchestrator; lock-file ownership *was* the barrier.

**Process isolation** is what the Agent SDK ships [26]: each subagent runs in a subprocess of the prebuilt CLI binary, separate from the Python host. Deterministic startup but adds undocumented IPC overhead.

# 7. Comparison vs Other Frameworks

|              | Orchestration model | State | Communication |
|---|---|---|---|
| **LangGraph** | Directed graph with conditional edges | Checkpointed, durable | Handoffs through state |
| **CrewAI** | Role-based crews with process types | Ephemeral | Shared memory between roles |
| **AutoGen / AG2** | Conversational GroupChat | Event-sourced (v0.4) | Multi-turn dialogue/messages |
| **Anthropic (Workflows + SDK)** | Deterministic JS script over fresh-context tool calls | Resumable via cached agent results | Return values only — no shared memory |

What's **the same**: all four converge on the orchestrator–worker shape, support parallel fan-out, and offer some form of evaluator loop [27][28].

What's **distinctive about Anthropic's 2026 stance**:

1. **The orchestrator is code, not a model.** AutoGen has agents debate; LangGraph routes through a state-machine model node; CrewAI has roles negotiate. Anthropic's workflows put the loop, the branch, and the merge in plain JavaScript so they're inspectable, deterministic, and resumable. The model is reserved for *leaf* judgement.

2. **No shared memory by default.** Communication is *only* through prompt strings and typed return values. Augment's analysis [26] lists this as a notable gap vs. competitors — Anthropic's bet is that fresh contexts, no state-leak, no compaction debt is actually a feature.

3. **Adversarial verification as a primitive.** Built into the bundled `/deep-research`. Most frameworks expose judging as a pattern you compose yourself.

4. **Worktree isolation as an explicit, costed option.** Filesystem collisions are first-class.

5. **Determinism bans baked in.** `Date.now()`, `Math.random()`, argless `new Date()` **throw** inside a workflow because they break resume — no other major framework enforces this at the API level.

What Anthropic conspicuously **doesn't** ship (per [26]): no built-in observability layer, no durable cross-session persistence, no native per-agent permission scoping for coordinator/specialist splits. Teams building production multi-agent systems on top of Claude still write their own tracing and audit layers.

## Decision rules, distilled

1. **One subagent, one task?** Use the plain Agent tool. No workflow.
2. **Reusable procedure, Claude picks the steps?** Skill.
3. **Fixed shape, parallel or multi-stage, worth resuming?** Workflow.
4. **Known list + one pass + final aggregation?** Fan-out + synthesize.
5. **Multi-stage and items don't need each other?** Pipeline (never two parallels with a transform between).
6. **Next stage needs the entire prior set?** Barrier — `parallel()`.
7. **Unknown count, fixed goal?** Loop until target.
8. **Unknown count, "find them all"?** Loop until dry.
9. **Depth should scale with user budget?** Loop until budget runs low.
10. **High-stakes finding?** Wrap it in adversarial verification.
11. **Wide solution space?** Judge panel with diverse angles.
12. **Agents mutate files?** `isolation: 'worktree'`. Otherwise don't pay the 200–500ms cost.

# 8. References

[1] Building Effective Agents — Anthropic. https://www.anthropic.com/research/building-effective-agents
[2] How we built our multi-agent research system — Anthropic Engineering. https://www.anthropic.com/engineering/multi-agent-research-system
[3] Introducing dynamic workflows in Claude Code — Anthropic Blog. https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
[4] Orchestrate subagents at scale with dynamic workflows — Claude Code Docs. https://code.claude.com/docs/en/workflows
[5] Anthropic Ships Claude Opus 4.8 Alongside Dynamic Workflows — marktechpost.com. https://www.marktechpost.com/2026/05/28/anthropic-ships-claude-opus-4-8-alongside-dynamic-workflows-and-cheaper-fast-mode-with-workflows-capped-at-1000-subagents/
[6] claude-code-workflow-creator (Ray Amjad) — SKILL.md and references/patterns.md. https://github.com/ray-amjad/claude-code-workflow-creator
[7] Create custom subagents — Claude Code Docs. https://code.claude.com/docs/en/sub-agents
[8] Interactive mode — Claude Code Docs. https://code.claude.com/docs/en/interactive-mode
[9] Claude Agent SDK overview — Claude Code Docs. https://code.claude.com/docs/en/agent-sdk/overview
[10] Subagents in the SDK — Claude Code Docs. https://code.claude.com/docs/en/agent-sdk/subagents
[11] Connect Claude Code to tools via MCP — Claude Code Docs. https://code.claude.com/docs/en/mcp
[12] Claude API Structured Output guide — Thomas Wiegold. https://thomas-wiegold.com/blog/claude-api-structured-output/
[13] Anthropic Prompt Caching docs. https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
[14] Hooks reference — Claude Code Docs. https://code.claude.com/docs/en/hooks
[15] How to configure hooks — claude.com blog. https://claude.com/blog/how-to-configure-hooks
[16] Skills reference — Claude Code Docs. https://code.claude.com/docs/en/skills
[17] Commands reference — Claude Code Docs. https://code.claude.com/docs/en/commands
[18] Status line — Claude Code Docs. https://code.claude.com/docs/en/statusline
[19] Keybindings — Claude Code Docs. https://code.claude.com/docs/en/keybindings
[20] Settings — Claude Code Docs. https://code.claude.com/docs/en/settings
[21] Memory — Claude Code Docs. https://code.claude.com/docs/en/memory
[22] Run prompts on a schedule — Claude Code Docs. https://code.claude.com/docs/en/scheduled-tasks
[23] ScheduleWakeup has no cancellation mechanism — github.com/anthropics/claude-code#58235. https://github.com/anthropics/claude-code/issues/58235
[24] Building a C compiler with a team of parallel Claudes — Anthropic Engineering. https://www.anthropic.com/engineering/building-c-compiler
[25] Run parallel sessions with worktrees — Claude Code Docs. https://code.claude.com/docs/en/worktrees
[26] Anthropic Agent SDK: What It Ships vs. What You Build — Augment Code. https://www.augmentcode.com/guides/anthropic-agent-sdk-what-ships-vs-what-you-build
[27] AI Agent Frameworks Compared: LangGraph vs CrewAI vs AutoGen — Pecollective. https://pecollective.com/blog/ai-agent-frameworks-compared/
[28] LangGraph vs CrewAI vs AutoGen vs Custom benchmark — Tensoria. https://tensoria.fr/en/blog/multi-agent-orchestration-comparison
[29] Run agents in parallel — Claude Code Docs. https://code.claude.com/docs/en/agents
[30] Building agents with the Claude Agent SDK — Anthropic Engineering. https://claude.com/blog/building-agents-with-the-claude-agent-sdk
[31] Agent SDK MCP guide — Claude Code Docs. https://code.claude.com/docs/en/agent-sdk/mcp
[32] @anthropic-ai/claude-agent-sdk on npm. https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
[33] anthropics/claude-agent-sdk-typescript. https://github.com/anthropics/claude-agent-sdk-typescript
[34] anthropics/claude-agent-sdk-python. https://github.com/anthropics/claude-agent-sdk-python
[35] anthropics/claude-agent-sdk-demos. https://github.com/anthropics/claude-agent-sdk-demos
[36] VoltAgent/awesome-claude-code-subagents. https://github.com/VoltAgent/awesome-claude-code-subagents
[37] Model Context Protocol. https://modelcontextprotocol.io/introduction
[38] Agent SDK hooks — platform.claude.com. https://platform.claude.com/docs/en/agent-sdk/hooks
[39] Agent SDK slash commands — platform.claude.com. https://platform.claude.com/docs/en/agent-sdk/slash-commands
[40] Anthropic skills repo. https://github.com/anthropics/skills
[41] Equipping agents with Agent Skills — anthropic.com. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
[42] Skill authoring best practices — platform.claude.com. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
[43] Built-in agent types in Claude Code — amitkoth.com. https://amitkoth.com/claude-code-agent-types/
[44] Claude Code Async: Background Agents & Parallel Tasks — claudefa.st. https://claudefa.st/blog/guide/agents/async-workflows
[45] Claude Code Advanced Patterns: Subagents, MCP, Scaling — Anthropic Resources PDF. https://resources.anthropic.com/hubfs/Claude%20Code%20Advanced%20Patterns_%20Subagents,%20MCP,%20and%20Scaling%20to%20Real%20Codebases.pdf
# Appendix A: Direct Observations From a Live Session

This appendix records what Claude (the assistant) can see directly inside a running Claude Code session — the exact tool surface, agent registry, hook signals, and memory paths visible in the system prompt of the run that produced this document (Hive private-release repo, 2026-05-29, Opus 4.7). It is meant as an empirical cross-check on the public-docs research above: where this appendix and the research disagree, the appendix is "ground truth for THIS build" and the research is "ground truth for the docs as written."

## A.1 Built-in agent types visible to Agent and Workflow

The session advertises six built-in subagent types via the `Agent` tool's `subagent_type` parameter:

| Name | Allowed tools | Stated purpose |
|---|---|---|
| `claude` | * (all) | Default catch-all when no name is given |
| `claude-code-guide` | `Bash, Read, WebFetch, WebSearch` | Questions about Claude Code, Agent SDK, Claude API; reuses an existing running instance via SendMessage if recent |
| `Explore` | All except Agent, ExitPlanMode, Edit, Write, NotebookEdit | Fast read-only search for code; not for review or open-ended analysis; takes a "breadth" parameter (quick/medium/very thorough) |
| `general-purpose` | * (all) | Researching complex questions, searching for code, multi-step tasks |
| `Plan` | All except Agent, ExitPlanMode, Edit, Write, NotebookEdit | Software-architect agent for designing implementation strategies |
| `statusline-setup` | `Read, Edit` | Configures the status line setting |

A few mechanics from the same description that the public docs don't always spell out:

- `subagent_type` is optional; omitting it routes to `claude` (the catch-all).
- The Agent tool can run in the foreground (default, blocking on the result) or in the background via `run_in_background: true`. Background agents notify the parent on completion via `<task-notification>` — explicit instructions tell the parent not to poll.
- `isolation: "worktree"` creates a temporary git worktree per agent call; the worktree is auto-deleted if the agent made no changes, otherwise its path and branch are returned in the result.

## A.2 Workflow tool surface, verbatim

The `Workflow` tool description in the session prompt provides the canonical contract for THIS build. Key facts that augment the research:

- The script must begin with `export const meta = { name, description, phases?, whenToUse?, model? }` and `meta` must be a **pure literal** — no variables, function calls, spreads, or template interpolation.
- `meta.phases[].title` must match the strings passed to `phase()` exactly for the progress tree to deduplicate the group.
- Workflow scripts are **plain JavaScript, NOT TypeScript** — type annotations, interfaces, and generics fail to parse. The script body runs in an async context (top-level `await` is OK).
- Standard JS built-ins are available **except** `Date.now()`, `Math.random()`, and argless `new Date()` — they throw because they would break resume. Pass timestamps in via `args`, stamp results after the workflow returns, and vary randomness by index in the agent prompt/label.
- No filesystem or Node.js API access from inside the workflow script. (Subagents the workflow spawns CAN have FS access depending on their `agentType`.)
- The 1000-agent lifetime cap is described as "a runaway-loop backstop set far above any real workflow."
- Per-session concurrency cap: `min(16, cpu cores - 2)`. Excess `agent()` calls queue automatically.
- `pipeline()` is the default; the docs explicitly push back against barriers: "A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1."

The DSL hooks I can use, copied from the tool description for fidelity:

```text
agent(prompt, opts?)         → Promise<any>   // string or schema-validated object
parallel(thunks)             → Promise<any[]> // BARRIER; null on per-item failure
pipeline(items, ...stages)   → Promise<any[]> // streaming; no barrier
phase(title)                 → void           // groups subsequent agent() calls
log(message)                 → void           // narrator line
workflow(name|{scriptPath}, args?) → Promise<any>  // one-level nesting
```

Globals: `args`, `budget.total`, `budget.spent()`, `budget.remaining()`.

`agent()` opts the description names explicitly: `label`, `phase`, `schema` (JSON-Schema; the model is forced to call a `StructuredOutput` tool and the validated object is returned), `model` (override the inherited session model), `isolation: 'worktree'`, `agentType`. Adding `schema` composes with `agentType` — the custom agent's system prompt is appended with a StructuredOutput instruction.

## A.3 Workflow resume

A workflow journal lives at the path printed when the Workflow returns: `~/.claude/projects/<project-hash>/subagents/workflows/wf_<run-id>/`. The script itself is persisted next to it at `~/.claude/projects/<project-hash>/workflows/scripts/<name>-wf_<run-id>.js`. Resume mechanics:

- Edit the script via Write/Edit; re-invoke Workflow with `{scriptPath, resumeFromRunId}`.
- The longest unchanged prefix of `agent()` calls returns cached results instantly.
- The first edited/new call and everything after it runs live.
- Same script + same args → 100% cache hit.
- Date.now/Math.random/new Date being unavailable in scripts is what makes this stable.

This is critical: workflows are not just spawn-and-pray. They are debuggable and iterable.

## A.4 Deferred-tools mechanism

The session does not load every tool's schema up-front. Heavy or rarely-used tools appear by name only in a system reminder; their full JSON schemas are fetched on demand via `ToolSearch`. From the listing visible at the moment of writing:

```text
CronCreate            CronDelete           CronList
EnterPlanMode         EnterWorktree
ExitPlanMode          ExitWorktree
ListMcpResourcesTool  Monitor
NotebookEdit          PushNotification
ReadMcpResourceTool   RemoteTrigger
TaskCreate            TaskGet              TaskList
TaskOutput            TaskStop             TaskUpdate
WebFetch              WebSearch
mcp__chrome-devtools__*  (50+ Chrome DevTools tools)
mcp__claude_ai_Notion__* (Notion tools)
mcp__evermemos-mcp__*    (memory MCP)
mcp__stitch__*           (Stitch design tools)
```

Two `ToolSearch` query forms are accepted: `select:Read,Edit,Grep` (exact names) and free-text keyword search. After a `ToolSearch` call returns a tool's schema, the tool is callable exactly as if it had been listed at the top of the prompt.

The practical consequence for a workflow author: the subagent prompts in this very document tell the research agents to "load WebFetch/WebSearch via ToolSearch first." That's because the agents inherit the same deferred-tool list and must materialize the schema before invocation.

## A.5 Hooks observed firing

During this session, only `UserPromptSubmit` and `SessionStart:resume` hooks were seen in the conversation log. Each fires a single line like `<system-reminder>UserPromptSubmit hook success: OK</system-reminder>`. The reminder text is the project's standard "no behavior change" success line. Hooks are configured in `~/.claude/settings.json` and `.claude/settings.local.json`; the research above (§4) covers the full event taxonomy.

Hooks come from the user/project settings, not from prompt-engineering. The runtime treats hook output as if it came from the user, and a blocked hook will surface as user feedback rather than a tool error — see the project's `# System` paragraph in the system prompt.

## A.6 Auto-memory mechanism

The session prompt includes a full `# auto memory` section instructing the assistant to maintain a persistent file-based memory at:

```text
/Users/admin/.claude/projects/-Users-admin-code-hive/memory/
```

Four memory types are defined (`user`, `feedback`, `project`, `reference`) each with rules for when to write, when to read, and a structured frontmatter format:

```markdown
---
name: short-kebab-case-slug
description: one-line summary for relevance ranking
metadata:
  type: user | feedback | project | reference
---

Content. Link related notes with [[other-name]].
```

`MEMORY.md` is the index — one `- [Title](file.md) — one-line hook` line per memory, capped at ~200 lines, always loaded into context. Memory files are NOT loaded into context by default; they are pulled on demand when something in the conversation references them.

Important constraint the system prompt names explicitly: do not store derivable codebase facts (paths, conventions, architecture) — those are recoverable from `git log`/`git blame`/CLAUDE.md. Memory is for facts that would otherwise be lost between sessions: user preferences, validated workflows, deadlines, references to external systems.

## A.7 Session-specific guidance the prompt encodes

Three concrete rules from the `# Session-specific guidance` block:

1. For broad codebase exploration of >3 queries, use the `Explore` subagent (read-only, breadth-parameterized). For single greps, use Bash directly.
2. The `/schedule` slash command should only be offered when the current turn left a NAMED artifact with a quoted future obligation (e.g. a flag with a ramp date). Never invent a default timeframe.
3. Skills appear in system reminders. Only invoke a skill that appears in that listing or one the user typed as `/<name>`. Don't guess from training data.

## A.8 The `<<autonomous-loop-dynamic>>` sentinel

The `ScheduleWakeup` tool description names a sentinel `<<autonomous-loop-dynamic>>` (and its CronCreate cousin `<<autonomous-loop>>`) that the runtime resolves back to autonomous-loop instructions at fire time. This is the mechanism Anthropic recommends for `/loop` loops that have no user prompt — the prompt is the sentinel, and the runtime substitutes the canonical autonomous-loop instructions when the wake-up fires.

## A.9 What this build's tool surface DOES NOT have

For symmetry with the public docs, these were absent from the visible tool listing in this session:

- No direct `EnterPlanMode`/`ExitPlanMode` calls in the main prompt — they appear only as deferred tools (loaded on demand by AskUserQuestion's plan-mode flow).
- No first-class `Agents` view tool — the `claude agents` CLI command is described in the docs (§2.7 of the research above) but not exposed as a session tool.
- No first-class "Agent Teams" tool. The research section §2.7 mentions an experimental teams feature; this session has only single-Claude-plus-subagents.

These absences may reflect the build version (Opus 4.7, not 4.8) or the user's enabled feature set, not a permanent gap.

# Appendix B: How Hive's Workflow Feature Maps to This Surface

The Hive private-release codebase this document lives in implements its OWN workflow runtime — independent from but inspired by Anthropic's. The 1:1 mapping for orientation:

| Concept | Anthropic's Workflow tool | Hive's `.hive/workflows/*.ts` runtime |
|---|---|---|
| Script location | `~/.claude/workflows/` or `.claude/workflows/` | `<workspace>/.hive/workflows/*.ts` |
| Meta extraction | Pure literal `meta` block | Same (verified at load time) |
| DSL | `agent/parallel/pipeline/phase/log/workflow` | `agent/parallel/pipeline/phase/log/workflow` |
| Subagents | Anthropic-registered agent types | Per-workspace ephemeral workers (one PTY per call) |
| Dispatch identity | Workflow runner inside Anthropic's CLI | `__workflow__:<workspaceId>` pseudo-agent in Hive's DB |
| Dispatch-await | Internal | `workflow-dispatch-awaiter` Promise registry |
| Schema validation | `schema` opt; StructuredOutput tool | Not yet implemented (M2-C deferred this) |
| Worktree isolation | `isolation: 'worktree'` opt per agent | Not yet implemented |
| Token budget | `budget.total/spent/remaining`, `+500k` directives | Not implemented; not relevant when each agent is a CLI subprocess, not an API call |
| Persistence | `workflow.jsonl` journal under `~/.claude/projects/.../` | `workflow_runs` + `dispatches` tables in SQLite v20/v21 |
| Resume | `{scriptPath, resumeFromRunId}` | Boot sweep marks unfinished runs as `interrupted`; no auto-resume by design (spec §13) |
| Schedules | Saved workflows + `/schedule` slash command | `workflow_schedules` table + cron-parser tick loop |
| UI | `/workflows` view + topbar | `WorkflowsDrawer` component (M4) with run timeline (M4.6), schedules (M4.5), templates (M5), editor (M5b), Stop (M7) |

The two systems are intentionally similar at the API level so a workflow written for Anthropic's runtime is structurally portable to Hive — the divergence is in the **executor**: Anthropic dispatches subagents over its API; Hive dispatches over PTYs to local CLI agents (claude, codex, opencode, gemini), so one workspace can mix vendors in a single run. This was the original motivation for Hive's workflow runtime per `CLAUDE.md`'s "Hive 是什么" section.
