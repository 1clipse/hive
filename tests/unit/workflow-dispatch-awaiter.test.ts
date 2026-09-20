import { describe, expect, test, vi } from 'vitest'

import { createWorkflowDispatchAwaiter } from '../../src/server/workflow-dispatch-awaiter.js'

describe('workflow dispatch awaiter', () => {
  test('resolves the awaiter when notifyReport arrives', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d1', 5000)
    a.notifyReport('d1', { text: 'ok', artifacts: [] })
    await expect(p).resolves.toEqual({ text: 'ok', artifacts: [] })
  })

  test('rejects when notifyCancel arrives', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d2', 5000)
    a.notifyCancel('d2', 'aborted')
    await expect(p).rejects.toThrow(/aborted/)
  })

  test('rejects on timeout', async () => {
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d3', 10)
    vi.advanceTimersByTime(50)
    await expect(p).rejects.toThrow(/timeout/i)
    vi.useRealTimers()
  })

  test('notifyReport for unknown dispatchId is deferred for the next awaiter', async () => {
    const a = createWorkflowDispatchAwaiter()
    a.notifyReport('unknown', { text: 'early', artifacts: [] })
    await expect(a.awaitReport('unknown', 5000)).resolves.toEqual({
      text: 'early',
      artifacts: [],
    })
  })

  test('notifyCancel BEFORE awaitReport rejects the subsequent await immediately (TIER 2 #10)', async () => {
    /* Regression for TIER 2 #10. The runner creates a dispatch and
       THEN calls awaitReport. If a stop fires in the microtask gap
       between the two, the old code's notifyCancel hit an empty
       pending map and no-op'd, and the awaitReport then waited the
       full 10-min DEFAULT_TIMEOUT_MS. With the deferred-cancel state,
       awaitReport sees the recorded cancel and rejects synchronously. */
    const a = createWorkflowDispatchAwaiter()
    a.notifyCancel('race-1', 'stop arrived early')
    await expect(a.awaitReport('race-1', 5000)).rejects.toThrow(/stop arrived early/)
  })

  test('notifyReport BEFORE awaitReport resolves the subsequent await immediately (TIER 2 #10)', async () => {
    /* Symmetric to the cancel case — a report racing ahead of the
       awaitReport registration shouldn't be lost. */
    const a = createWorkflowDispatchAwaiter()
    a.notifyReport('race-2', { text: 'early', artifacts: [] })
    await expect(a.awaitReport('race-2', 5000)).resolves.toEqual({
      text: 'early',
      artifacts: [],
    })
  })

  test('deferred events expire instead of staying in memory forever', async () => {
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter({ deferredEventTtlMs: 100 })
    a.notifyCancel('expired', 'too old')

    vi.advanceTimersByTime(101)
    const p = a.awaitReport('expired', 50)
    vi.advanceTimersByTime(51)

    await expect(p).rejects.toThrow(/timeout/)
    vi.useRealTimers()
  })

  test('deferred event cache is capped for unknown ids', async () => {
    const a = createWorkflowDispatchAwaiter({ maxDeferredEvents: 2 })
    a.notifyReport('old-report', { text: 'old', artifacts: [] })
    a.notifyCancel('old-cancel', 'old')
    a.notifyCancel('new-cancel', 'new')

    await expect(a.awaitReport('new-cancel', 5000)).rejects.toThrow(/new/)
    await expect(a.awaitReport('old-cancel', 5000)).rejects.toThrow(/old/)

    vi.useFakeTimers()
    const p = a.awaitReport('old-report', 50)
    vi.advanceTimersByTime(51)
    await expect(p).rejects.toThrow(/timeout/)
    vi.useRealTimers()
  })

  test('deferred cancel state is consumed once — a second awaitReport for the same id waits normally', async () => {
    /* A late notifyCancel should only short-circuit the NEXT
       awaitReport for that id; a third awaitReport on the same id
       (unusual but possible if the runner retried) should wait for
       new events, not auto-reject from a stale cancel. */
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter()
    a.notifyCancel('once', 'first')
    await expect(a.awaitReport('once', 5000)).rejects.toThrow(/first/)
    // Second await must wait — confirm by advancing to timeout.
    const p2 = a.awaitReport('once', 50)
    vi.advanceTimersByTime(100)
    await expect(p2).rejects.toThrow(/timeout/)
    vi.useRealTimers()
  })

  test('cancelAll rejects every pending', async () => {
    const a = createWorkflowDispatchAwaiter()
    const p1 = a.awaitReport('a', 5000)
    const p2 = a.awaitReport('b', 5000)
    a.cancelAll('shutdown')
    await expect(p1).rejects.toThrow(/shutdown/)
    await expect(p2).rejects.toThrow(/shutdown/)
  })

  test('forceCancel rejects a current waiter without creating deferred state for a future waiter', async () => {
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter()
    const p1 = a.awaitReport('force', 5000)
    a.forceCancel('force', 'cleanup timed out')

    await expect(p1).rejects.toThrow(/cleanup timed out/)

    const p2 = a.awaitReport('force', 50)
    vi.advanceTimersByTime(51)
    await expect(p2).rejects.toThrow(/timeout/)
    vi.useRealTimers()
  })

  test('a resolved awaiter clears its timeout (no leaks)', async () => {
    vi.useFakeTimers()
    const a = createWorkflowDispatchAwaiter()
    const p = a.awaitReport('d4', 100)
    a.notifyReport('d4', { text: 'fast', artifacts: [] })
    await expect(p).resolves.toEqual({ text: 'fast', artifacts: [] })
    // Advance past the timeout; should NOT fire (would have rejected an already-resolved promise).
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
  })
})
