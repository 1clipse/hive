// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWorkspaceWorkers', () => {
  test('loads worker summaries for every local workspace id, not only the active workspace', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        a: [
          {
            id: 'wa',
            lastPtyLine: undefined,
            name: 'Alice',
            pendingTaskCount: 1,
            role: 'coder',
            status: 'working',
          },
        ],
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('prunes worker summaries when a workspace is removed from the local list', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') {
        return json([
          { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
        ])
      }
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      {
        initialProps: { workspaceIds: ['a', 'b'] },
      }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
      expect(result.current[0]).toHaveProperty('b')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({
        b: [
          {
            id: 'wb',
            lastPtyLine: undefined,
            name: 'Bob',
            pendingTaskCount: 0,
            role: 'tester',
            status: 'idle',
          },
        ],
      })
    })
  })

  test('keeps the same workspace map reference when refreshed worker payloads are unchanged', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json([{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }])
      )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWorkspaceWorkers(['a'], { activeWorkspaceId: 'a' }))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0]).toHaveProperty('a')
    const firstMap = result.current[0]

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current[0]).toBe(firstMap)
  })

  test('updates when only a worker command preset changes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json([
          {
            id: 'wa',
            name: 'Alice',
            role: 'coder',
            status: 'idle',
            pending_task_count: 0,
            command_preset_id: 'claude',
          },
        ])
      )
      .mockResolvedValueOnce(
        json([
          {
            id: 'wa',
            name: 'Alice',
            role: 'coder',
            status: 'idle',
            pending_task_count: 0,
            command_preset_id: 'codex',
          },
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWorkspaceWorkers(['a'], { activeWorkspaceId: 'a' }))

    await act(async () => {
      await flushPromises()
    })
    expect(result.current[0].a?.[0]?.commandPresetId).toBe('claude')

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(result.current[0].a?.[0]?.commandPresetId).toBe('codex')
  })

  test('replaces stale workspace keys even when the next workspace has no workers', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/ui/workspaces/a/team') {
        return json([
          { id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 },
        ])
      }
      if (url === '/api/ui/workspaces/b/team') return json([])
      throw new Error(`Unexpected fetch ${url}`)
    })

    const { rerender, result } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      { initialProps: { workspaceIds: ['a'] } }
    )

    await waitFor(() => {
      expect(result.current[0]).toHaveProperty('a')
    })

    rerender({ workspaceIds: ['b'] })

    await waitFor(() => {
      expect(result.current[0]).toEqual({ b: [] })
    })
  })

  test('backs off failed refreshes and does not overlap in-flight worker requests', async () => {
    vi.useFakeTimers()
    let resolveFirstFetch: ((response: Response) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirstFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(
        json([{ id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 }])
      )
    vi.stubGlobal('fetch', fetchMock)

    renderHook(() => useWorkspaceWorkers(['a'], { activeWorkspaceId: 'a' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstFetch?.(json([]))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      await flushPromises()
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('polls the active workspace frequently while background workspaces stay on the slow interval', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      const workerName = url.includes('/a/') ? 'Alice' : 'Bob'
      return json([
        {
          id: `w-${workerName}`,
          name: workerName,
          role: 'coder',
          status: 'idle',
          pending_task_count: 0,
        },
      ])
    })

    renderHook(() => useWorkspaceWorkers(['a', 'b'], { activeWorkspaceId: 'a' }))

    await act(async () => {
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(1)
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(2)
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(4500)
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(2)
  })

  test('refreshes a workspace promptly when it becomes active', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      return json([])
    })

    const { rerender } = renderHook(
      ({ activeWorkspaceId }: { activeWorkspaceId: string }) =>
        useWorkspaceWorkers(['a', 'b'], { activeWorkspaceId }),
      { initialProps: { activeWorkspaceId: 'a' } }
    )

    await act(async () => {
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(1)

    rerender({ activeWorkspaceId: 'b' })
    await act(async () => {
      await flushPromises()
    })

    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(2)
  })

  test('refreshes a preserved workspace promptly after stale in-flight polling is cancelled', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    let resolveFirstA!: (response: Response) => void
    const firstAResponse = new Promise<Response>((resolve) => {
      resolveFirstA = resolve
    })
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (
        url === '/api/ui/workspaces/a/team' &&
        calls.filter((call) => call === url).length === 1
      ) {
        return firstAResponse
      }
      return json([])
    }) as typeof fetch)

    const { rerender } = renderHook(
      ({ workspaceIds }: { workspaceIds: string[] }) => useWorkspaceWorkers(workspaceIds),
      { initialProps: { workspaceIds: ['a', 'b'] } }
    )

    await act(async () => {
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(1)

    await act(async () => {
      rerender({ workspaceIds: ['a', 'c'] })
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(1)
    expect(calls.filter((url) => url === '/api/ui/workspaces/c/team')).toHaveLength(1)

    await act(async () => {
      resolveFirstA(json([]))
      await flushPromises()
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(2)
  })

  test('a failing background workspace does not slow down the active workspace', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url === '/api/ui/workspaces/b/team') throw new Error('background failed')
      return json([])
    })

    renderHook(() => useWorkspaceWorkers(['a', 'b'], { activeWorkspaceId: 'a' }))

    await act(async () => {
      await flushPromises()
    })
    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(1)
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await flushPromises()
    })

    expect(calls.filter((url) => url === '/api/ui/workspaces/a/team')).toHaveLength(2)
    expect(calls.filter((url) => url === '/api/ui/workspaces/b/team')).toHaveLength(1)
  })
})
