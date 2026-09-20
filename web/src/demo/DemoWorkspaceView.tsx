import { CheckCircle2, Circle, Terminal, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useI18n } from '../i18n.js'
import { DemoBanner } from './DemoBanner.js'

type DemoWorkspaceViewProps = {
  onExit: () => void
}

const DEMO_STEPS = [
  {
    label: 'Plan',
    terminal: [
      '$ hive demo',
      'Orchestrator: turning the request into .hive/tasks.md',
      '$ team spawn coder --name ada-lovelace',
      '$ team spawn reviewer --name socrates',
    ],
    doneTasks: 1,
    workerStates: ['idle', 'idle'],
  },
  {
    label: 'Dispatch',
    terminal: [
      '$ team send ada-lovelace "Implement POST /todos with SQLite persistence"',
      'Hive: dispatch queued and delivered to ada-lovelace',
      'ada-lovelace: editing src/routes/todos.ts',
    ],
    doneTasks: 2,
    workerStates: ['working', 'idle'],
  },
  {
    label: 'Report',
    terminal: [
      'ada-lovelace: team report "POST /todos implemented; tests added"',
      'Orchestrator: marking implementation done, sending review',
      '$ team send socrates "Review todo endpoint and tests"',
    ],
    doneTasks: 3,
    workerStates: ['idle', 'working'],
  },
  {
    label: 'Close',
    terminal: [
      'socrates: team report "No blocker; one naming nit fixed"',
      'Orchestrator: validation complete',
      'tasks.md: all demo tasks checked',
    ],
    doneTasks: 5,
    workerStates: ['idle', 'idle'],
  },
] as const

const TASKS = [
  'Create the Todo API route',
  'Persist todos in SQLite',
  'Add Vitest coverage',
  'Review route behavior',
  'Mark .hive/tasks.md complete',
]

const WORKERS = [
  { name: 'ada-lovelace', role: 'Coder' },
  { name: 'socrates', role: 'Reviewer' },
]

export const DemoWorkspaceView = ({ onExit }: DemoWorkspaceViewProps) => {
  const { t } = useI18n()
  const [stepIndex, setStepIndex] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStepIndex((current) => (current + 1) % DEMO_STEPS.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [])

  const step = DEMO_STEPS[stepIndex] ?? DEMO_STEPS[0]
  const terminalLines = useMemo(
    () => DEMO_STEPS.slice(0, stepIndex + 1).flatMap((item) => item.terminal),
    [stepIndex]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DemoBanner onExit={onExit} />
      <div className="scroll-y min-h-0 flex-1 px-4 py-4" style={{ background: 'var(--bg-2)' }}>
        <section
          className="mx-auto grid h-full min-h-[520px] w-full max-w-6xl gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]"
          data-testid="demo-replay-panel"
        >
          <div className="flex min-h-0 flex-col rounded-md border bg-0">
            <header
              className="flex items-center justify-between border-b px-3 py-2"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Terminal size={15} className="text-accent" />
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold text-pri">
                    {t('demo.replayTitle')}
                  </h1>
                  <p className="text-xs text-ter">{t('demo.replaySubtitle')}</p>
                </div>
              </div>
              <span className="rounded border px-2 py-1 text-[11px] text-sec">{step.label}</span>
            </header>
            <pre
              className="mono min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-xs leading-6 text-sec"
              data-testid="demo-replay-terminal"
            >
              {terminalLines.join('\n')}
            </pre>
          </div>

          <aside className="flex min-h-0 flex-col gap-3">
            <div className="rounded-md border bg-0 p-3" data-testid="demo-task-graph">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-pri">{t('demo.tasksTitle')}</h2>
                <span className="text-xs text-ter">
                  {Math.min(step.doneTasks, TASKS.length)}/{TASKS.length}
                </span>
              </div>
              <ul className="space-y-2">
                {TASKS.map((task, index) => {
                  const done = index < step.doneTasks
                  return (
                    <li
                      key={task}
                      className="flex items-start gap-2 text-sm"
                      data-testid={`demo-task-${index}`}
                      data-done={done || undefined}
                    >
                      {done ? (
                        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-status-green" />
                      ) : (
                        <Circle size={16} className="mt-0.5 shrink-0 text-ter" />
                      )}
                      <span className={done ? 'text-pri' : 'text-sec'}>{task}</span>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="rounded-md border bg-0 p-3" data-testid="demo-team">
              <div className="mb-3 flex items-center gap-2">
                <Users size={15} className="text-accent" />
                <h2 className="text-sm font-semibold text-pri">{t('demo.teamTitle')}</h2>
              </div>
              <div className="grid gap-2">
                {WORKERS.map((worker, index) => {
                  const state = step.workerStates[index] ?? 'idle'
                  return (
                    <div
                      key={worker.name}
                      className="rounded border px-3 py-2"
                      data-testid={`demo-worker-${worker.name}`}
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-pri">{worker.name}</span>
                        <span className="rounded px-1.5 py-0.5 text-[11px] text-sec bg-2">
                          {state}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ter">{worker.role}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </div>
  )
}
