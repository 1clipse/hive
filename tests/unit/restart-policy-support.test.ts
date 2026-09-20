import { describe, expect, test, vi } from 'vitest'

import { writeSystemMessage } from '../../src/server/restart-policy-support.js'
import {
  buildMemoryDigestSafely,
  logMemoryDigestInjection,
  rollbackMemoryDigestInjection,
  type TeamMemoryInjectionService,
} from '../../src/server/team-memory-injection.js'

describe('restart-policy memory helpers', () => {
  test('writeSystemMessage invokes the rollback hook when the async write fails', async () => {
    const deleted: number[] = []
    const rolledBack: string[] = []

    writeSystemMessage({
      deleteMessage: (handle) => {
        deleted.push(handle.sequence)
      },
      insertMessage: () => ({ sequence: 42 }),
      onWriteFailure: () => {
        rolledBack.push('memory-injection')
      },
      record: {
        createdAt: 1,
        text: 'recovery',
        type: 'system_recovery_summary',
        workerId: 'agent-1',
        workspaceId: 'ws',
      },
      runId: 'run-1',
      text: 'recovery',
      writeToRun: async () => {
        throw new Error('run is gone')
      },
    })

    await vi.waitFor(() => {
      expect(rolledBack).toEqual(['memory-injection'])
      expect(deleted).toEqual([42])
    })
  })

  test('buildMemoryDigestSafely degrades to no digest when the memory provider fails', () => {
    const error = new Error('bad tags json')
    const memoryInjection: TeamMemoryInjectionService = {
      buildDigest: () => {
        throw error
      },
      buildDispatchDigest: () => null,
      deleteInjections: () => {},
      logInjections: () => [],
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(
      buildMemoryDigestSafely({
        contextType: 'startup',
        memoryInjection,
        workspaceId: 'ws',
      })
    ).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith('[hive] memory digest build failed', error)

    consoleSpy.mockRestore()
  })

  test('logMemoryDigestInjection returns null when audit rows cannot be written', () => {
    const error = new Error('readonly database')
    const memoryInjection: TeamMemoryInjectionService = {
      buildDigest: () => ({ memoryIds: ['memory-1'], text: '<hive-memory />' }),
      buildDispatchDigest: () => null,
      deleteInjections: () => {},
      logInjections: () => {
        throw error
      },
    }
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(
      logMemoryDigestInjection({
        agentId: 'agent-1',
        contextType: 'recovery',
        memoryDigest: { memoryIds: ['memory-1'], text: '<hive-memory />' },
        memoryInjection,
        workspaceId: 'ws',
      })
    ).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith('[hive] memory injection audit failed', error)

    consoleSpy.mockRestore()
  })

  test('rollbackMemoryDigestInjection removes previously written audit rows', () => {
    const deleted: string[][] = []
    const memoryInjection: TeamMemoryInjectionService = {
      buildDigest: () => ({ memoryIds: ['memory-1'], text: '<hive-memory />' }),
      buildDispatchDigest: () => null,
      deleteInjections: (injectionIds) => {
        deleted.push(injectionIds)
      },
      logInjections: () => ['injection-1'],
    }

    rollbackMemoryDigestInjection({
      injectionIds: ['injection-1'],
      memoryInjection,
    })

    expect(deleted).toEqual([['injection-1']])
  })
})
