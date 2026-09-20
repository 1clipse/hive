import { CronExpressionParser } from 'cron-parser'
import type { WorkflowRunRecord } from './workflow-run-store.js'
import type { RunWorkflowInput } from './workflow-runner.js'
import type { createWorkflowScheduleStore } from './workflow-schedule-store.js'

type ScheduleStore = ReturnType<typeof createWorkflowScheduleStore>

export interface WorkflowSchedulerDeps {
  schedules: ScheduleStore
  startWorkflow: (input: RunWorkflowInput) => Promise<WorkflowRunRecord>
  /** Defensive guard against orphan schedules (TIER 1 #4). The workspace
   *  delete cascade clears workflow_schedules in the same transaction so
   *  fresh orphans cannot appear; this port catches any pre-existing or
   *  externally-introduced orphan and self-heals by deleting the schedule
   *  before it can fire and crash startWorkflow → re-fire next tick. */
  workspaceExists?: (workspaceId: string) => boolean
  /** HivePort to pass into every fired workflow. Resolved lazily so the
   *  scheduler doesn't need to be reconstructed when the runtime listens
   *  on a different port (e.g. tests using port 0). */
  getHivePort?: () => string
  /** Test seam: defaults to cron-parser. Returns next fire time in ms-epoch. */
  computeNextRunAt?: (cron: string, after: Date) => number
  /** Experimental workflow gate. When provided and returns false, ticks fire
   *  nothing (scheduled runs are held, not dropped — they fire once re-enabled).
   *  Omitted → no gate (the scheduler unit tests rely on this default). */
  isWorkflowEnabled?: () => boolean
  /** Skip starting a schedule when a previous top-level run of the same
   *  workspace+script is still `running`. Omitted → no overlap guard
   *  (CAS still prevents two ticks from claiming the same next_run_at). */
  hasRunningScheduledWorkflow?: (schedule: {
    id: string
    workspaceId: string
    scriptPath: string
  }) => boolean
}

export interface WorkflowScheduler {
  /** Run one tick using the given `now` (ms-epoch). For both production and tests. */
  tick: (now?: number) => Promise<void>
  /** Arm a setInterval that calls tick() every `tickIntervalMs`. Returns void. */
  start: (input?: { tickIntervalMs?: number }) => void
  /** Clear the timer. Idempotent. */
  close: () => void
}

const defaultComputeNextRunAt = (cron: string, after: Date): number => {
  // cron-parser 5.x: `currentDate` is the reference point; `next()` returns
  // the first strictly-greater fire. UTC by default.
  const expr = CronExpressionParser.parse(cron, { currentDate: after, tz: 'UTC' })
  return expr.next().toDate().getTime()
}

const DEFAULT_TICK_INTERVAL_MS = 30_000

export const createWorkflowScheduler = (deps: WorkflowSchedulerDeps): WorkflowScheduler => {
  const computeNext = deps.computeNextRunAt ?? defaultComputeNextRunAt
  let timer: NodeJS.Timeout | null = null
  let closed = false
  // In-flight (workspaceId, scriptPath) starts: a startWorkflow call that
  // claimed its schedule but has not yet returned. Covers the window before
  // the run row exists, where hasRunningScheduledWorkflow cannot yet see the
  // run — a re-due tick would otherwise fire a second copy during a slow
  // script load. Keyed by workspace+script (same semantics as
  // hasRunningScheduledWorkflow) so different schedule ids targeting the
  // same script cannot overlap either. Entries are always released in a
  // finally, on success and on failure.
  const inFlightStarts = new Set<string>()
  const startKey = (workspaceId: string, scriptPath: string) => `${workspaceId} ${scriptPath}`

  const scheduler: WorkflowScheduler = {
    async tick(now = Date.now()) {
      if (closed) return
      // Experimental gate: while workflows are disabled, hold all scheduled
      // runs (don't fire, don't advance nextRunAt) so they resume cleanly
      // once re-enabled.
      if (deps.isWorkflowEnabled && !deps.isWorkflowEnabled()) return
      const due = deps.schedules.listDueSchedules(now)
      for (const schedule of due) {
        if (closed) return
        // TIER 1 #4 — self-heal orphan schedules: if a schedule survived a
        // workspace-delete operation (shouldn't happen after the cascade
        // fix, but defending against historical orphans), drop it now so
        // it doesn't error-spam every tick from here forward.
        if (deps.workspaceExists && !deps.workspaceExists(schedule.workspaceId)) {
          console.warn('[hive] workflow-scheduler: deleting orphan schedule', {
            scheduleId: schedule.id,
            workspaceId: schedule.workspaceId,
          })
          deps.schedules.deleteSchedule(schedule.id)
          continue
        }
        if (inFlightStarts.has(startKey(schedule.workspaceId, schedule.scriptPath))) {
          continue
        }
        if (
          deps.hasRunningScheduledWorkflow?.({
            id: schedule.id,
            workspaceId: schedule.workspaceId,
            scriptPath: schedule.scriptPath,
          })
        ) {
          continue
        }
        // Compute the next fire BEFORE firing this one so a startWorkflow
        // exception cannot keep us re-firing the same row each tick.
        let nextRunAt: number
        try {
          nextRunAt = computeNext(schedule.cron, new Date(now))
        } catch (error) {
          console.error('[hive] workflow-scheduler: invalid cron, disabling schedule', {
            scheduleId: schedule.id,
            cron: schedule.cron,
            error: error instanceof Error ? error.message : String(error),
          })
          deps.schedules.update(schedule.id, { enabled: false })
          continue
        }
        // TIER 1 #5 — compare-and-swap claim. If a previous tick is still
        // running (slow esbuild / slow startWorkflow / many due schedules
        // in one tick) and setInterval fires again, both ticks would
        // otherwise see the same due schedule and fire it twice. CAS on
        // the original next_run_at means only the first tick wins;
        // losers see changes=0 and quietly skip.
        const claimed = deps.schedules.claimDueSchedule({
          id: schedule.id,
          expectedNextRunAt: schedule.nextRunAt ?? 0,
          newNextRunAt: nextRunAt,
          lastRunAt: now,
        })
        if (!claimed) continue
        const key = startKey(schedule.workspaceId, schedule.scriptPath)
        inFlightStarts.add(key)
        try {
          await deps.startWorkflow({
            workspaceId: schedule.workspaceId,
            scriptPath: schedule.scriptPath,
            hivePort: deps.getHivePort?.() ?? '',
            ...(schedule.args !== undefined && schedule.args !== null
              ? { args: schedule.args }
              : {}),
          })
        } catch (error) {
          console.error('[hive] workflow-scheduler: startWorkflow failed', {
            scheduleId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          inFlightStarts.delete(key)
        }
      }
    },
    start({ tickIntervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
      if (closed) return
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        scheduler.tick().catch((error) => {
          console.error('[hive] swallowed:workflow-scheduler.tick', error)
        })
      }, tickIntervalMs)
    },
    close() {
      closed = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }

  return scheduler
}
