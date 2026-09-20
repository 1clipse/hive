// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { AppWorkspaceContent } from '../../web/src/AppWorkspaceContent.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import type { WorkerActions } from '../../web/src/worker/useWorkerActions.js'

const shellRun = vi.hoisted<TerminalRunSummary>(() => ({
  agent_id: 'ws-1:shell',
  agent_name: 'Shell',
  run_id: 'run-shell-1',
  status: 'running',
}))

vi.mock('../../web/src/WorkspaceDetail.js', () => ({
  WorkspaceDetail: ({
    onShellRunStarted,
  }: {
    onShellRunStarted?: (workspaceId: string, run: TerminalRunSummary) => void
  }) => (
    <button
      type="button"
      data-testid="emit-shell-run"
      onClick={() => onShellRunStarted?.('ws-1', shellRun)}
    >
      emit shell
    </button>
  ),
}))

afterEach(() => {
  cleanup()
})

const workspace: WorkspaceSummary = {
  id: 'ws-1',
  name: 'Alpha',
  path: '/tmp/alpha',
}

const workerActions: WorkerActions = {
  createWorker: vi.fn(),
  deleteWorker: vi.fn(),
  restartWorkerRun: vi.fn(),
  startWorker: vi.fn(),
  stopWorkerRun: vi.fn(),
  updateWorkerAvatar: vi.fn(),
}

describe('AppWorkspaceContent', () => {
  test('passes shell runs through the active workspace content boundary', async () => {
    const onShellRunStarted = vi.fn()
    const polledRun: TerminalRunSummary = {
      agent_id: `${workspace.id}:orchestrator`,
      agent_name: 'Orchestrator',
      run_id: 'polled-run',
      status: 'running',
    }

    render(
      <AppWorkspaceContent
        activeId={workspace.id}
        activeWorkspace={workspace}
        bootstrapError={null}
        demoMode={false}
        onDeleteWorkspace={vi.fn()}
        onExitDemo={vi.fn()}
        onOrchestratorRunClosed={vi.fn()}
        onRequestAddWorkspace={vi.fn()}
        onShellRunClosed={vi.fn()}
        onShellRunStarted={onShellRunStarted}
        onTryDemo={vi.fn()}
        orchestratorAutostartErrors={{}}
        recordOrchestratorResult={vi.fn()}
        terminalRuns={[polledRun]}
        workerActions={workerActions}
        workers={[]}
      />
    )

    fireEvent.click(screen.getByTestId('emit-shell-run'))

    expect(onShellRunStarted).toHaveBeenCalledWith(workspace.id, shellRun)
    expect(screen.queryByTestId('terminal-panels')).toBeNull()
  })

  test('does not own terminal panel mounting', () => {
    render(
      <AppWorkspaceContent
        activeId={workspace.id}
        activeWorkspace={workspace}
        bootstrapError={null}
        demoMode={false}
        onDeleteWorkspace={vi.fn()}
        onExitDemo={vi.fn()}
        onOrchestratorRunClosed={vi.fn()}
        onRequestAddWorkspace={vi.fn()}
        onShellRunClosed={vi.fn()}
        onShellRunStarted={vi.fn()}
        onTryDemo={vi.fn()}
        orchestratorAutostartErrors={{}}
        recordOrchestratorResult={vi.fn()}
        terminalRuns={[]}
        workerActions={workerActions}
        workers={[]}
      />
    )

    expect(screen.queryByTestId('terminal-panels')).toBeNull()
  })
})
