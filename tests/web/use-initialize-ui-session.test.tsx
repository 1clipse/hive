// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import {
  getActiveWorkspaceId,
  initializeUiSession,
  listWorkspaces,
  saveActiveWorkspaceId,
} from '../../web/src/api.js'
import {
  UI_SESSION_BOOTSTRAP_TIMEOUT_MS,
  useInitializeUiSession,
} from '../../web/src/useInitializeUiSession.js'

vi.mock('../../web/src/api.js', () => ({
  getActiveWorkspaceId: vi.fn(),
  initializeUiSession: vi.fn(),
  listWorkspaces: vi.fn(),
  saveActiveWorkspaceId: vi.fn(),
}))

const mockedInitializeUiSession = vi.mocked(initializeUiSession)
const mockedListWorkspaces = vi.mocked(listWorkspaces)
const mockedGetActiveWorkspaceId = vi.mocked(getActiveWorkspaceId)
const mockedSaveActiveWorkspaceId = vi.mocked(saveActiveWorkspaceId)

const WORKSPACES: WorkspaceSummary[] = [{ id: 'ws-1', name: 'Workspace 1', path: '/tmp/ws-1' }]

const Harness = ({ onError }: { onError?: (message: string) => void }) => {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>('initial')
  useInitializeUiSession(setWorkspaces, setActiveWorkspaceId, onError)
  return (
    <div data-testid="bootstrap-state">
      {JSON.stringify({
        activeWorkspaceId,
        workspaceCount: workspaces?.length ?? null,
      })}
    </div>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  mockedInitializeUiSession.mockResolvedValue(undefined)
  mockedListWorkspaces.mockResolvedValue(WORKSPACES)
  mockedGetActiveWorkspaceId.mockResolvedValue('ws-1')
  mockedSaveActiveWorkspaceId.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useInitializeUiSession', () => {
  test('loads workspaces and resolves the active workspace before the timeout', async () => {
    render(<Harness />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('bootstrap-state')).toHaveTextContent(
      JSON.stringify({ activeWorkspaceId: 'ws-1', workspaceCount: 1 })
    )
    expect(mockedSaveActiveWorkspaceId).not.toHaveBeenCalled()
  })

  test('surfaces a bootstrap error instead of spinning forever when workspace loading hangs', async () => {
    mockedListWorkspaces.mockReturnValue(new Promise<WorkspaceSummary[]>(() => {}))
    const onError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<Harness onError={onError} />)

    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(UI_SESSION_BOOTSTRAP_TIMEOUT_MS)
      await Promise.resolve()
    })

    expect(screen.getByTestId('bootstrap-state')).toHaveTextContent(
      JSON.stringify({ activeWorkspaceId: null, workspaceCount: null })
    )
    expect(onError).toHaveBeenCalledWith(
      'Could not reach Hive runtime. Refresh once the runtime is back up.'
    )
    expect(consoleError).toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
