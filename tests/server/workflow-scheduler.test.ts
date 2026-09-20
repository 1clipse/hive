import { describe, expect, test, vi } from 'vitest'
import Database from '../../src/server/sqlite.js'

import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkflowScheduleStore } from '../../src/server/workflow-schedule-store.js'
import { createWorkflowScheduler } from '../../src/server/workflow-scheduler.js'

const make = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return createWorkflowScheduleStore(db)
}

describe('workflow-scheduler', () => {
  test('fires due schedules and rewrites lastRunAt + nextRunAt', async () => {
    const schedules = make()
    const fired: Array<{ scriptPath: string }> = []
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push({ scriptPath: input.scriptPath })
        return {} as never
      },
      // Inject a deterministic "next" so the test doesn't depend on wall time.
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
    })
    const s = schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '*/1 * * * *',
      nextRunAt: 100,
    })
    await scheduler.tick(500)
    expect(fired).toEqual([{ scriptPath: 'p' }])
    const updated = schedules.get(s.id)
    expect(updated?.lastRunAt).toBe(500)
    expect(updated?.nextRunAt).toBe(500 + 60_000)
  })

  test('holds all schedules (no fire, nextRunAt unchanged) while the workflow feature is disabled', async () => {
    const schedules = make()
    const fired: string[] = []
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push(input.scriptPath)
        return {} as never
      },
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
      isWorkflowEnabled: () => false,
    })
    const s = schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '*/1 * * * *',
      nextRunAt: 100,
    })
    await scheduler.tick(500)
    expect(fired).toEqual([])
    const held = schedules.get(s.id)
    // Held, not dropped: nextRunAt is untouched so it fires once re-enabled.
    expect(held?.nextRunAt).toBe(100)
    expect(held?.lastRunAt ?? null).toBeNull()
  })

  test('a startWorkflow failure does not halt the scheduler; nextRunAt still advances', async () => {
    const schedules = make()
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async () => {
        throw new Error('boom')
      },
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
    })
    const s = schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    await scheduler.tick(500)
    const updated = schedules.get(s.id)
    // nextRunAt advanced even though the workflow failed — prevents spin.
    expect(updated?.nextRunAt).toBe(500 + 60_000)
  })

  test('disabled schedules are not fired even when due', async () => {
    const schedules = make()
    const fired: string[] = []
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push(input.scriptPath)
        return {} as never
      },
      computeNextRunAt: () => 999_999_999,
    })
    const s = schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    schedules.update(s.id, { enabled: false })
    await scheduler.tick(500)
    expect(fired).toEqual([])
  })

  test('start() arms a tick interval; close() clears it', async () => {
    vi.useFakeTimers()
    const schedules = make()
    let ticks = 0
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async () => ({}) as never,
      computeNextRunAt: () => 999_999_999_999,
    })
    // Spy the public tick by wrapping a flag; we approximate by counting via setInterval ticks.
    const originalTick = scheduler.tick
    scheduler.tick = async (now) => {
      ticks++
      return originalTick(now)
    }
    scheduler.start({ tickIntervalMs: 100 })
    vi.advanceTimersByTime(350)
    // Allow promises to settle.
    await Promise.resolve()
    expect(ticks).toBeGreaterThanOrEqual(3)
    scheduler.close()
    const before = ticks
    vi.advanceTimersByTime(500)
    expect(ticks).toBe(before)
    vi.useRealTimers()
  })

  test('skips a tick while the previous run of that schedule is still running', async () => {
    const schedules = make()
    const fired: string[] = []
    let previousStillRunning = false
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push(input.scriptPath)
        previousStillRunning = true
        return { id: `run-${fired.length}`, status: 'running' } as never
      },
      hasRunningScheduledWorkflow: () => previousStillRunning,
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
    })
    schedules.create({
      workspaceId: 'ws',
      scriptPath: 'slow.ts',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    await scheduler.tick(1_000_000)
    await scheduler.tick(1_000_000 + 60_000)
    await scheduler.tick(1_000_000 + 120_000)
    expect(fired).toEqual(['slow.ts'])
  })

  test('overlapping ticks (slow startWorkflow) fire each due row exactly once (TIER 1 #5)', async () => {
    /* Regression for TIER 1 #5: when tick A is awaiting a slow
       startWorkflow on row 1, the next setInterval fire (tick B) reads
       listDueSchedules and gets back row 2 (since A already updated
       row 1). After A's startWorkflow resolves, A moves to row 2 — but
       row 2 was just claimed by B. Without CAS, A's update silently
       overwrites B's (rewriting next_run_at) AND A awaits another
       startWorkflow on row 2 — duplicate fire, duplicate worker spawn,
       duplicate workflow_run row.

       With CAS, A's update on row 2 hits zero rows (B already
       advanced next_run_at) and A skips the fire. Each row is fired
       exactly once across both ticks. */
    const schedules = make()
    const fired: string[] = []
    const releases: Array<() => void> = []
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push(input.scriptPath)
        await new Promise<void>((r) => releases.push(r))
        return {} as never
      },
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
    })
    schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p1',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    schedules.create({
      workspaceId: 'ws',
      scriptPath: 'p2',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    // Tick A starts, processes p1, then awaits inside startWorkflow.
    const tA = scheduler.tick(500)
    // Give A a microtask to enter startWorkflow's await.
    await new Promise((r) => setTimeout(r, 5))
    expect(fired).toEqual(['p1'])
    // Tick B fires while A is still awaiting on p1.
    const tB = scheduler.tick(500)
    // Let B race through; B sees p2 (p1 already advanced) and starts it.
    await new Promise((r) => setTimeout(r, 5))
    expect(fired).toEqual(['p1', 'p2'])
    // Release p1 — A wakes, moves to p2. Without CAS, A would call
    // startWorkflow('p2') again. With CAS, A's claim fails and A skips.
    releases[0]?.()
    await new Promise((r) => setTimeout(r, 5))
    // Release p2 as well so tick B can complete.
    releases[1]?.()
    await Promise.all([tA, tB])
    // The whole point — each row fired exactly once.
    expect(fired).toEqual(['p1', 'p2'])
  })

  test('an orphan schedule (workspace no longer exists) is self-healed, not fired (TIER 1 #4)', async () => {
    /* Defensive guard for #4: even with the deleteWorkspace cascade in
       place, a schedule from a pre-fix data file or external import
       could still reference a workspace that no longer exists. Without
       this guard, the scheduler would call startWorkflow on the dead
       workspace, that would throw in getWorkflowAgentId, the catch
       would advance nextRunAt by one tick, and the loop would error-spam
       forever. With the guard, the schedule is deleted on first sight
       and never fires. */
    const schedules = make()
    const fired: string[] = []
    const scheduler = createWorkflowScheduler({
      schedules,
      startWorkflow: async (input) => {
        fired.push(input.scriptPath)
        return {} as never
      },
      workspaceExists: () => false,
      computeNextRunAt: (_cron, after) => after.getTime() + 60_000,
    })
    const s = schedules.create({
      workspaceId: 'orphan-ws',
      scriptPath: 'p',
      cron: '* * * * *',
      nextRunAt: 100,
    })
    await scheduler.tick(500)
    // The workflow MUST NOT fire — the whole point of the guard.
    expect(fired).toEqual([])
    // The schedule MUST be deleted so it doesn't appear at next tick either.
    expect(schedules.get(s.id)).toBeUndefined()
  })
})
