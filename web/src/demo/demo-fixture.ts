import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'

export const DEMO_WORKSPACE: WorkspaceSummary = {
  id: 'demo-workspace',
  name: 'demo-todo-app',
  path: '/Users/you/demo-todo-app',
}

/**
 * The orchestrator is split out from `DEMO_WORKERS` to match production:
 * `listWorkers` excludes the orchestrator from the team list. Threading it
 * into the workers array would render queen as a worker card alongside
 * ada-lovelace and socrates, which is not how Hive actually behaves.
 *
 * Worker names here are fixed demo identities (not drawn from the live
 * agent-name-bank pool in `src/shared/random-worker-name.ts`).
 */
export const DEMO_ORCHESTRATOR = {
  id: 'demo-orch',
  name: 'queen',
  status: 'idle' as const,
  pendingTaskCount: 0,
}

export const DEMO_WORKERS: TeamListItem[] = [
  {
    id: 'demo-coder',
    name: 'ada-lovelace',
    role: 'coder',
    status: 'working',
    pendingTaskCount: 1,
    lastPtyLine: 'Editing src/routes/todos.ts (line 42)',
    commandPresetId: 'claude',
  },
  {
    id: 'demo-reviewer',
    name: 'socrates',
    role: 'reviewer',
    status: 'idle',
    pendingTaskCount: 0,
    commandPresetId: 'gemini',
  },
]

export const DEMO_TASKS_MD = `# Todo app

- [x] Set up Express server
- [x] Add /todos GET endpoint
- [ ] Add /todos POST endpoint
- [ ] Write Vitest for both endpoints
- [ ] Wire up SQLite for persistence
`

export const DEMO_TERMINAL_SCROLLBACK: Record<string, string> = {
  'demo-orch':
    '$ team send ada-lovelace "Implement POST /todos"\r\n' +
    '> dispatched to ada-lovelace\r\n' +
    '$ team list\r\n' +
    '> ada-lovelace: working (1 task)\r\n' +
    '> socrates: idle\r\n',
  'demo-coder':
    'Reading src/routes/todos.ts ...\r\n' +
    'Drafting POST handler ...\r\n' +
    'Editing src/routes/todos.ts (line 42)\r\n',
  'demo-reviewer': 'Idle — waiting for review tasks.\r\n',
}
