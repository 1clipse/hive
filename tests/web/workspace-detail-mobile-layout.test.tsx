// @vitest-environment jsdom
//
// M5b impl:adapt — WorkspaceDetail on a narrow viewport. The desktop two-pane
// row (orchestrator min-w-[480px] + draggable pane-splitter + workers) does not
// fit a phone: at ~360px the 480px orchestrator pushes the workers/terminal off
// screen and forces horizontal scroll. The mobile branch stacks the panes in a
// single column, drops the fixed min-width, and removes the drag splitter
// (Parity Matrix marks resize ⚠️ "fixed/折叠 on mobile, no drag"). Desktop must
// stay byte-identical: the splitter + the 480px min-width are still present.

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { NotificationProvider } from '../../web/src/notifications/NotificationProvider.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { WorkspaceDetail } from '../../web/src/WorkspaceDetail.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Alpha', path: '/tmp/alpha' }
const worker: TeamListItem = {
  id: 'worker-1',
  name: 'Alice',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
}

const shellRun = (runId = 'shell-run-1'): TerminalRunSummary => ({
  agent_id: `${workspace.id}:shell`,
  agent_name: 'Shell',
  run_id: runId,
  status: 'running',
})

const ui = (terminalRuns: TerminalRunSummary[] = []) => (
  <I18nProvider>
    <ToastProvider>
      <NotificationProvider>
        <WorkspaceDetail
          onCreateWorker={vi.fn()}
          onDeleteWorker={vi.fn()}
          onDeleteWorkspace={vi.fn()}
          onStartWorker={vi.fn()}
          onStopWorker={vi.fn()}
          onRestartWorker={vi.fn()}
          onUpdateWorkerAvatar={vi.fn(async () => ({ error: null }))}
          onOrchestratorResult={vi.fn()}
          onRequestAddWorkspace={vi.fn()}
          orchestratorAutostartError={null}
          terminalRuns={terminalRuns}
          workers={[worker]}
          workspace={workspace}
        />
      </NotificationProvider>
    </ToastProvider>
  </I18nProvider>
)

describe('WorkspaceDetail mobile layout', () => {
  test('mobile stacks the panes: no drag splitter, no fixed 480px min-width', () => {
    renderMobile(ui())
    const panes = screen.getByTestId('workspace-detail-panes')
    expect(panes).toHaveAttribute('data-mobile', 'true')
    // Stacked column, not a side-by-side row.
    expect(panes.className).toContain('flex-col')

    // The draggable splitter is a desktop affordance — gone on a phone.
    expect(screen.queryByTestId('pane-splitter')).toBeNull()

    // The orchestrator shell must NOT carry the 480px min-width that overflows
    // a 360px viewport.
    expect(screen.queryByTestId('orchestrator-pane-shell')).toBeNull()

    // Both panes are still present (capability is stacked, not cut).
    expect(screen.getByTestId('orchestrator-terminal-slot')).toBeInTheDocument()
    expect(screen.getByText('Team members')).toBeInTheDocument()
  })

  test('mobile workers pane owns its own scroll area when the terminal panel is open', async () => {
    renderMobile(ui([shellRun()]))

    fireEvent.click(screen.getByTestId('mobile-team-tab-workers'))
    fireEvent.click(screen.getByTestId('open-workspace-shell'))
    expect(await screen.findByTestId('terminal-bottom-panel')).toBeInTheDocument()

    const workersPane = screen.getByTestId('workers-pane')
    expect(workersPane.className).toContain('min-h-0')

    const workersBody = document.querySelector('.workers-pane-body')
    expect(workersBody?.className).toContain('min-h-0')
    expect(workersBody?.className).toContain('scroll-y')
  })

  test('desktop keeps the two-pane row: splitter present + 480px min-width (zero-regression)', () => {
    renderWide(ui())
    const panes = screen.getByTestId('workspace-detail-panes')
    expect(panes).not.toHaveAttribute('data-mobile')
    // Desktop is a side-by-side row, not a stacked column.
    expect(panes.className).not.toContain('flex-col')

    expect(screen.getByTestId('pane-splitter')).toBeInTheDocument()
    const orchShell = screen.getByTestId('orchestrator-pane-shell')
    expect(orchShell.className).toContain('min-w-[480px]')
    expect(orchShell.getAttribute('style') ?? '').toContain('width')
  })
})
