import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { SettingsStore } from './settings-store.js'
import type { DreamScheduleState } from './team-memory-dream-store.js'
import {
  readWorkspaceMemoryDreamEnabled,
  readWorkspaceMemoryEnabled,
  workspaceMemoryDreamEnabledKey,
  workspaceMemoryEnabledKey,
} from './team-memory-feature.js'

export const DREAM_SCHEDULER_FLOOR_MS = 20 * 60 * 1000
// The first failure still retries at the base floor (transient hiccups recover fast);
// each *additional* consecutive scheduled failure doubles the floor (capped), so a window
// that keeps failing is retried ever more slowly instead of burning the CLI every floor.
// At 20min × 2^5 the slowest retry is ~10.6h; a success resets the count and the floor.
export const DREAM_SCHEDULER_BACKOFF_CAP = 5
export const DREAM_SCHEDULER_IDLE_DEBOUNCE_MS = 60_000
export const DREAM_SCHEDULER_MIN_MESSAGES = 1
export const DREAM_SCHEDULER_TICK_INTERVAL_MS = 30_000

interface WorkspaceSnapshot {
  agents: AgentSummary[]
}

export interface TeamMemoryDreamSchedulerDeps {
  floorMs?: number
  getScheduleState: (workspaceId: string) => DreamScheduleState
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceSnapshot
  idleDebounceMs?: number
  listWorkspaces: () => WorkspaceSummary[]
  logError?: (workspaceId: string, error: unknown) => void
  minMessages?: number
  now?: () => number
  runScheduled: (workspaceId: string) => Promise<unknown>
  settings: SettingsStore
}

export interface TeamMemoryDreamScheduler {
  close: () => Promise<void>
  start: (input?: { tickIntervalMs?: number }) => void
  tick: (now?: number) => Promise<void>
}

const hasWorkingAgent = (agents: AgentSummary[]) =>
  agents.some((agent) => agent.status === 'working')

const isDreamEnabled = (settings: SettingsStore, workspaceId: string) =>
  readWorkspaceMemoryEnabled(settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value) &&
  readWorkspaceMemoryDreamEnabled(
    settings.getAppState(workspaceMemoryDreamEnabledKey(workspaceId))?.value
  )

export const createTeamMemoryDreamScheduler = (
  deps: TeamMemoryDreamSchedulerDeps
): TeamMemoryDreamScheduler => {
  const floorMs = deps.floorMs ?? DREAM_SCHEDULER_FLOOR_MS
  const idleDebounceMs = deps.idleDebounceMs ?? DREAM_SCHEDULER_IDLE_DEBOUNCE_MS
  const minMessages = deps.minMessages ?? DREAM_SCHEDULER_MIN_MESSAGES
  const now = deps.now ?? (() => Date.now())
  const logError =
    deps.logError ??
    ((workspaceId, error) => {
      console.error('[hive] memory dream scheduler failed', { workspaceId, error })
    })
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  let tickInFlight = false
  let tickPromise: Promise<void> | undefined
  const idleSinceByWorkspace = new Map<string, number>()

  const clearTimer = () => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }

  const scheduler: TeamMemoryDreamScheduler = {
    async close() {
      closed = true
      clearTimer()
      await tickPromise?.catch((error) => {
        console.error('[hive] swallowed:memory-dream-scheduler.close', error)
      })
    },
    start({ tickIntervalMs = DREAM_SCHEDULER_TICK_INTERVAL_MS } = {}) {
      closed = false
      clearTimer()
      timer = setInterval(() => {
        void scheduler.tick().catch((error) => {
          console.error('[hive] swallowed:memory-dream-scheduler.tick', error)
        })
      }, tickIntervalMs)
      timer.unref?.()
    },
    async tick(tickNow = now()) {
      if (closed) return
      if (tickInFlight) {
        await tickPromise
        return
      }
      tickInFlight = true
      tickPromise = (async () => {
        const eligibleWorkspaces: WorkspaceSummary[] = []
        for (const workspace of deps.listWorkspaces()) {
          try {
            if (!isDreamEnabled(deps.settings, workspace.id)) {
              idleSinceByWorkspace.delete(workspace.id)
              continue
            }
            if (hasWorkingAgent(deps.getWorkspaceSnapshot(workspace.id).agents)) {
              idleSinceByWorkspace.delete(workspace.id)
              continue
            }
            const previousIdleSince = idleSinceByWorkspace.get(workspace.id)
            const idleSince =
              previousIdleSince === undefined || tickNow < previousIdleSince
                ? tickNow
                : previousIdleSince
            idleSinceByWorkspace.set(workspace.id, idleSince)
            if (tickNow - idleSince < idleDebounceMs) continue
            const state = deps.getScheduleState(workspace.id)
            if (state.hasRunningRun && !state.runningScheduledRunId) continue
            if (!state.runningScheduledRunId && state.pendingMessageCount < minMessages) continue
            const effectiveFloorMs =
              floorMs *
              2 **
                Math.min(
                  Math.max(0, state.consecutiveScheduledFailures - 1),
                  DREAM_SCHEDULER_BACKOFF_CAP
                )
            const sinceLastScheduled =
              state.lastScheduledAt === null ? null : tickNow - state.lastScheduledAt
            if (sinceLastScheduled !== null && sinceLastScheduled < effectiveFloorMs) continue
            eligibleWorkspaces.push(workspace)
          } catch (error) {
            logError(workspace.id, error)
          }
        }
        await Promise.all(
          eligibleWorkspaces.map(async (workspace) => {
            try {
              await deps.runScheduled(workspace.id)
            } catch (error) {
              logError(workspace.id, error)
            }
          })
        )
      })()
      try {
        await tickPromise
      } finally {
        tickPromise = undefined
        tickInFlight = false
      }
    },
  }

  return scheduler
}
