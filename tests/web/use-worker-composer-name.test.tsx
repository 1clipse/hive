// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import { useWorkerComposer } from '../../web/src/worker/useWorkerComposer.js'

// Deterministic, distinct names so a regeneration is detectable purely by the
// value changing — we assert on real composer state, not on mock call counts.
const { generateWorkerName } = vi.hoisted(() => ({ generateWorkerName: vi.fn() }))
vi.mock('../../src/shared/random-worker-name.js', () => ({ generateWorkerName }))

// The composer fires template/preset fetches on open. Stub them as
// never-resolving so they neither hit the network nor enqueue setState during
// these synchronous assertions.
vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    listCommandPresets: vi.fn(() => new Promise(() => {})),
    listRoleTemplates: vi.fn(() => new Promise(() => {})),
  }
})

const createWorker = async () => ({ error: null, runId: null })

const setup = (open: boolean) =>
  renderHook(
    (props: { open: boolean; workers: TeamListItem[] }) =>
      useWorkerComposer({ createWorker, ...props }),
    { initialProps: { open, workers: [] as TeamListItem[] } }
  )

beforeEach(() => {
  let n = 0
  generateWorkerName.mockReset()
  generateWorkerName.mockImplementation(() => `gen-${++n}`)
})

afterEach(() => cleanup())

describe('useWorkerComposer — name generation', () => {
  test('opening the composer auto-fills a random name', () => {
    const { result, rerender } = setup(false)
    // Closed: nothing seeded yet.
    expect(result.current.workerName).toBe('')
    rerender({ open: true, workers: [] })
    // Opened: a random name is ready without the user clicking anything.
    expect(result.current.workerName).not.toBe('')
  })

  test('a background roster update does NOT regenerate the name (the self-changing bug)', () => {
    const { result, rerender } = setup(true)
    act(() => {
      result.current.randomizeWorkerName()
    })
    const picked = result.current.workerName
    // Simulate a team-list refresh over WebSocket: a fresh `workers` array
    // identity, but the user changed nothing. This used to re-draw the name.
    rerender({ open: true, workers: [] })
    expect(result.current.workerName).toBe(picked)
  })

  test('switching role while still auto refreshes the name for the new role', () => {
    const { result } = setup(true)
    const seeded = result.current.workerName
    act(() => {
      result.current.setWorkerRole('reviewer')
    })
    expect(result.current.workerName).not.toBe(seeded)
  })

  test('a user-typed name survives a role switch (auto flag cleared by typing)', () => {
    const { result } = setup(true)
    act(() => {
      result.current.setWorkerName('my-name')
    })
    act(() => {
      result.current.setWorkerRole('tester')
    })
    expect(result.current.workerName).toBe('my-name')
  })
})
