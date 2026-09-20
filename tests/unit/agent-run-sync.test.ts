import { describe, expect, test } from 'vitest'

import { completeLiveRun, syncPersistedRun } from '../../src/server/agent-run-sync.js'
import type { LiveAgentRun } from '../../src/server/agent-runtime-types.js'

const createRun = (userStopped = false): LiveAgentRun => ({
  agentId: 'agent-1',
  exitCode: null,
  output: '',
  pid: 123,
  runId: 'run-1',
  startedAt: Date.now(),
  status: 'running',
  ...(userStopped ? { userStopped: true } : {}),
})

describe('agent run sync', () => {
  test('keeps ordinary non-zero exits classified as errors', () => {
    const run = createRun()
    const updates: unknown[] = []

    completeLiveRun(run, 1, 1234, {
      updatePersistedRun: (...args) => updates.push(args),
    })

    expect(run.status).toBe('error')
    expect(updates).toEqual([['run-1', 'error', 1, 1234]])
  })

  test('classifies explicit user stops as exited even when Windows reports a non-zero code', () => {
    const run = createRun(true)
    const updates: unknown[] = []

    completeLiveRun(run, 1, 1234, {
      updatePersistedRun: (...args) => updates.push(args),
    })

    expect(run.status).toBe('exited')
    expect(updates).toEqual([['run-1', 'exited', 1, 1234]])
  })

  test('does not mutate a live run when completing persistence fails', () => {
    const run = createRun()

    expect(() =>
      completeLiveRun(run, 1, 1234, {
        updatePersistedRun: () => {
          throw new Error('sqlite write failed')
        },
      })
    ).toThrow('sqlite write failed')

    expect(run.status).toBe('running')
    expect(run.exitCode).toBeNull()
  })

  test('does not mutate a live run when snapshot persistence fails', () => {
    const run = createRun()
    run.output = 'old output'

    expect(() =>
      syncPersistedRun(
        run,
        {
          agentId: 'agent-1',
          exitCode: 0,
          output: 'new output',
          pid: 123,
          runId: 'run-1',
          status: 'exited',
        },
        {
          updatePersistedRun: () => {
            throw new Error('sqlite write failed')
          },
        }
      )
    ).toThrow('sqlite write failed')

    expect(run.status).toBe('running')
    expect(run.exitCode).toBeNull()
    expect(run.output).toBe('old output')
  })
})
