import { useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../src/shared/types.js'
import { listWorkers } from './api.js'

const ACTIVE_REFRESH_INTERVAL_MS = 500
const BACKGROUND_REFRESH_INTERVAL_MS = 5000
const MAX_REFRESH_INTERVAL_MS = 5000

interface UseWorkspaceWorkersOptions {
  activeWorkspaceId?: string | null
}

interface WorkspacePollState {
  failureCount: number
  inFlight: boolean
  lastSettledAt: number | null
}

const createPollState = (): WorkspacePollState => ({
  failureCount: 0,
  inFlight: false,
  lastSettledAt: null,
})

const getRefreshDelay = (failureCount: number, active: boolean) => {
  const base = active ? ACTIVE_REFRESH_INTERVAL_MS : BACKGROUND_REFRESH_INTERVAL_MS
  return Math.min(base * 2 ** failureCount, MAX_REFRESH_INTERVAL_MS)
}

const areWorkersEqual = (a: TeamListItem[], b: TeamListItem[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((worker, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      worker.avatar === other.avatar &&
      worker.commandPresetId === other.commandPresetId &&
      worker.id === other.id &&
      worker.lastPtyLine === other.lastPtyLine &&
      worker.name === other.name &&
      worker.pendingTaskCount === other.pendingTaskCount &&
      worker.role === other.role &&
      worker.startupReadyAt === other.startupReadyAt &&
      worker.status === other.status
    )
  })
}

const areWorkerMapsEqual = (
  a: Record<string, TeamListItem[]>,
  b: Record<string, TeamListItem[]>
): boolean => {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return bKeys.every(
    (workspaceId) =>
      Object.hasOwn(a, workspaceId) && areWorkersEqual(a[workspaceId] ?? [], b[workspaceId] ?? [])
  )
}

export const useWorkspaceWorkers = (
  workspaceIds: readonly string[],
  options: UseWorkspaceWorkersOptions = {}
) => {
  const workspaceKey = workspaceIds.join('\0')
  const activeWorkspaceIdRef = useRef<string | null | undefined>(options.activeWorkspaceId)
  const pollStatesRef = useRef(new Map<string, WorkspacePollState>())
  const wakePollerRef = useRef<(() => void) | null>(null)
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

  activeWorkspaceIdRef.current = options.activeWorkspaceId

  useEffect(() => {
    if (!workspaceKey) {
      setWorkersByWorkspaceId({})
      pollStatesRef.current.clear()
      return
    }
    let cancelled = false
    let timeout: number | undefined
    const ids = workspaceKey.split('\0')
    const idSet = new Set(ids)

    for (const workspaceId of pollStatesRef.current.keys()) {
      if (!idSet.has(workspaceId)) pollStatesRef.current.delete(workspaceId)
    }
    setWorkersByWorkspaceId((current) => {
      const next: Record<string, TeamListItem[]> = {}
      for (const workspaceId of ids) next[workspaceId] = current[workspaceId] ?? []
      return areWorkerMapsEqual(current, next) ? current : next
    })

    const pollStateFor = (workspaceId: string) => {
      let state = pollStatesRef.current.get(workspaceId)
      if (!state) {
        state = createPollState()
        pollStatesRef.current.set(workspaceId, state)
      }
      return state
    }

    const isActiveWorkspace = (workspaceId: string) => activeWorkspaceIdRef.current === workspaceId

    const loadWorkspace = (workspaceId: string) => {
      const state = pollStateFor(workspaceId)
      if (state.inFlight) return
      state.inFlight = true
      void listWorkers(workspaceId)
        .then((workers) => {
          if (cancelled) return
          state.failureCount = 0
          setWorkersByWorkspaceId((current) => {
            if (!idSet.has(workspaceId)) return current
            const next: Record<string, TeamListItem[]> = {}
            for (const id of ids) next[id] = id === workspaceId ? workers : (current[id] ?? [])
            return areWorkerMapsEqual(current, next) ? current : next
          })
        })
        .catch((error) => {
          if (!cancelled) {
            state.failureCount = Math.min(state.failureCount + 1, 4)
            console.error('[hive] swallowed:workspaceWorkers.list', error)
          }
        })
        .finally(() => {
          state.inFlight = false
          state.lastSettledAt = cancelled ? null : Date.now()
        })
    }

    const refreshDueWorkspaces = () => {
      const now = Date.now()
      for (const workspaceId of ids) {
        const state = pollStateFor(workspaceId)
        if (state.inFlight) continue
        if (state.lastSettledAt === null) {
          loadWorkspace(workspaceId)
          continue
        }
        const delay = getRefreshDelay(state.failureCount, isActiveWorkspace(workspaceId))
        if (now - state.lastSettledAt >= delay) loadWorkspace(workspaceId)
      }
    }

    const scheduleNextLoad = (delay = ACTIVE_REFRESH_INTERVAL_MS) => {
      if (cancelled) return
      if (timeout !== undefined) window.clearTimeout(timeout)
      timeout = window.setTimeout(() => {
        timeout = undefined
        refreshDueWorkspaces()
        scheduleNextLoad()
      }, delay)
    }

    wakePollerRef.current = () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout)
        timeout = undefined
      }
      refreshDueWorkspaces()
      scheduleNextLoad()
    }

    refreshDueWorkspaces()
    scheduleNextLoad()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (wakePollerRef.current) wakePollerRef.current = null
    }
  }, [workspaceKey])

  useEffect(() => {
    const activeWorkspaceId = options.activeWorkspaceId
    if (!activeWorkspaceId || !workspaceKey.split('\0').includes(activeWorkspaceId)) return
    const state = pollStatesRef.current.get(activeWorkspaceId)
    if (state && !state.inFlight) {
      state.lastSettledAt = null
      state.failureCount = 0
    }
    wakePollerRef.current?.()
  }, [options.activeWorkspaceId, workspaceKey])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
