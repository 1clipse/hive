# Hive Desktop conversation prototype

> THROWAWAY PRIMARY SOURCE — do not promote this code directly to production.

## Question

How should a Codex-like, conversation-first Hive Desktop expose multi-agent execution without turning the default UI back into a terminal grid or an operations dashboard?

## Run

```bash
pnpm prototype:desktop
```

Open `http://127.0.0.1:5180/prototype-hive-desktop.html?variant=A`.

- `?variant=A` — Inline narrative
- `?variant=B` — Persistent team rail
- `?variant=C` — Team stage
- Use the floating arrows or keyboard Left/Right to switch.
- Click the floating label to cycle `running / attention / complete / paused` sample states.

All state is in memory. No Hive API, PTY, database, or real permission is touched.

## Current verdict

Use **A — Inline narrative** as the default product skeleton:

1. The main conversation remains the only default user input surface.
2. A TeamRun is one compact, expandable item between the Orchestrator lead-in and final answer.
3. An Agent opens as a right-side child thread with dispatch, structured events, report, and optional raw terminal evidence.
4. Approval/question/critical failure is promoted to the main conversation; routine reports stay inside TeamRun or Agent thread.
5. Stop scopes are explicit: TeamRun, one Agent, or one turn. Terminal remains an advanced escape hatch.

Borrow from the other variants selectively:

- **B** is a useful optional “supervision mode” for long-running teams, not the default layout.
- **C** makes parallelism legible, but belongs in Tasks/Workflow detail rather than the primary chat surface.

## Interaction decisions exercised

- Expand/collapse TeamRun members.
- Open an Agent child thread.
- Resolve an approval and expose the resulting state.
- Stop/resume a TeamRun.
- Open raw terminal evidence.
- Send a follow-up while running; it is presented as a steer of the current TeamRun.
- Share/reload a variant through the URL query.
- Preserve keyboard variant switching without intercepting arrows while typing.

## Still intentionally fake

- Agent and event data.
- Approval execution.
- Runtime completion and state transitions.
- Backend capability degradation.
- Persistence/replay.
- Electron window chrome and native menus.

The production implementation must be rewritten against the Conversation/Team/Backend contracts after the visual hierarchy is accepted.
