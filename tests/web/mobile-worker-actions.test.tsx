// @vitest-environment jsdom
//
// M5b impl:adapt-a — the WorkerCard hover action cluster must become reachable
// touch buttons on mobile (no `:hover` gate), and the full
// start/stop/restart/delete/rename set must be invokable, each firing its
// handler with the correct id (stop/restart need the run id, not the worker
// id). Parity row: "agent create/start/stop/restart/delete/rename".

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TeamListItem } from '../../src/shared/types.js'
import type { TerminalRunSummary } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { WorkerCard, type WorkerCardActionKind } from '../../web/src/worker/WorkerCard.js'
import { WorkersPane } from '../../web/src/worker/WorkersPane.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
})

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'ember-check-23',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

const tinyAvatar =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

const run = (agentId: string, runId: string): TerminalRunSummary => ({
  agent_id: agentId,
  agent_name: agentId,
  run_id: runId,
  status: 'running',
})

const withI18n = (ui: React.ReactElement) => <I18nProvider>{ui}</I18nProvider>

const openWorkerMenu = (workerId: string) => {
  fireEvent.click(screen.getByTestId(`worker-card-menu-${workerId}`))
  return screen.getByTestId(`worker-action-sheet-${workerId}`)
}

const noopRenameWorker = async () => ({ error: null })

describe('mobile WorkerCard action cluster reachability', () => {
  test('mobile card forces the action cluster visible (not gated behind :hover)', () => {
    renderMobile(
      withI18n(
        <WorkerCard
          hasRun={false}
          onClick={vi.fn()}
          onAction={vi.fn()}
          onRenameWorker={noopRenameWorker}
          worker={worker()}
        />
      )
    )
    const shell = document.querySelector('.worker-card-shell') as HTMLElement
    // The mobile branch tags the shell so the always-visible CSS can apply.
    // Reversed (no flag) would leave opacity:0 + pointer-events:none → untappable.
    expect(shell).toHaveAttribute('data-mobile', 'true')
  })

  test('desktop card does NOT set the mobile flag (zero-regression)', () => {
    renderWide(
      withI18n(
        <WorkerCard
          hasRun={false}
          onClick={vi.fn()}
          onAction={vi.fn()}
          onRenameWorker={noopRenameWorker}
          worker={worker()}
        />
      )
    )
    const shell = document.querySelector('.worker-card-shell') as HTMLElement
    expect(shell).not.toHaveAttribute('data-mobile')
  })

  test('idle worker (no run): start + rename + delete present and fire onAction', () => {
    const onAction = vi.fn<(kind: WorkerCardActionKind, w: TeamListItem) => void>()
    renderMobile(
      withI18n(
        <WorkerCard
          hasRun={false}
          onClick={vi.fn()}
          onAction={onAction}
          onRenameWorker={noopRenameWorker}
          worker={worker()}
        />
      )
    )
    fireEvent.click(within(openWorkerMenu('worker-1')).getByTestId('worker-card-start-worker-1'))
    fireEvent.click(within(openWorkerMenu('worker-1')).getByTestId('worker-card-rename-worker-1'))
    fireEvent.click(within(openWorkerMenu('worker-1')).getByTestId('worker-card-delete-worker-1'))

    const kinds = onAction.mock.calls.map((c) => c[0])
    expect(kinds).toEqual(['start', 'rename', 'delete'])
    // No run → stop/restart must NOT be offered (nothing to stop).
    const sheet = openWorkerMenu('worker-1')
    expect(within(sheet).queryByTestId('worker-card-stop-worker-1')).toBeNull()
    expect(within(sheet).queryByTestId('worker-card-restart-worker-1')).toBeNull()
  })

  test('running worker (hasRun): stop + restart present (and start hidden) and fire onAction', () => {
    const onAction = vi.fn<(kind: WorkerCardActionKind, w: TeamListItem) => void>()
    renderMobile(
      withI18n(
        <WorkerCard
          hasRun
          onClick={vi.fn()}
          onAction={onAction}
          onRenameWorker={noopRenameWorker}
          worker={worker()}
        />
      )
    )
    // start gated on !hasRun
    const startSheet = openWorkerMenu('worker-1')
    expect(within(startSheet).queryByTestId('worker-card-start-worker-1')).toBeNull()
    fireEvent.click(within(startSheet).getByTestId('worker-card-stop-worker-1'))
    fireEvent.click(within(openWorkerMenu('worker-1')).getByTestId('worker-card-restart-worker-1'))

    const kinds = onAction.mock.calls.map((c) => c[0])
    expect(kinds).toEqual(['stop', 'restart'])
  })

  test('desktop running worker: Stop/Restart are NOT on the card (zero-regression vs main)', () => {
    // The card's Stop/Restart are a mobile-only addition. The desktop hover
    // cluster must stay exactly as it was on `main` (Start-or-nothing + Rename +
    // Delete) — surfacing Stop/Restart on the desktop card would be a wide-branch
    // change the M5b "no desktop change" guarantee forbids. Un-gating the buttons
    // makes this fail.
    renderWide(
      withI18n(
        <WorkerCard
          hasRun
          onClick={vi.fn()}
          onAction={vi.fn()}
          onRenameWorker={noopRenameWorker}
          worker={worker()}
        />
      )
    )
    expect(screen.queryByTestId('worker-card-stop-worker-1')).toBeNull()
    expect(screen.queryByTestId('worker-card-restart-worker-1')).toBeNull()
    expect(screen.queryByTestId('worker-card-start-worker-1')).toBeNull()
    // Rename + Delete still present on desktop (unchanged from main).
    expect(screen.getByTestId('worker-card-rename-worker-1')).toBeTruthy()
    expect(screen.getByTestId('worker-card-delete-worker-1')).toBeTruthy()
  })
})

describe('mobile WorkersPane wires stop/restart to the run id (not the worker id)', () => {
  const renderPane = (props: Partial<Parameters<typeof WorkersPane>[0]> = {}) => {
    const onStartWorker = vi.fn()
    const onStopWorker = vi.fn<(runId: string) => void>()
    const onRestartWorker = vi.fn<(workerId: string, runId: string) => void>()
    const onDeleteWorker = vi.fn()
    const onRenameWorker = vi.fn(async () => ({ error: null }))
    const onUpdateWorkerAvatar = vi.fn(async () => ({ error: null }))
    renderMobile(
      withI18n(
        <WorkersPane
          onAddWorkerClick={vi.fn()}
          onDeleteWorker={onDeleteWorker}
          onOpenShellTerminal={vi.fn()}
          onOpenWorker={vi.fn()}
          onRenameWorker={onRenameWorker}
          onUpdateWorkerAvatar={onUpdateWorkerAvatar}
          onStartWorker={onStartWorker}
          onStopWorker={onStopWorker}
          onRestartWorker={onRestartWorker}
          startingWorkerId={null}
          terminalRuns={[run('busy', 'run-busy-77')]}
          workers={[worker({ id: 'busy', name: 'busy-agent', status: 'working' })]}
          {...props}
        />
      )
    )
    return {
      onDeleteWorker,
      onRenameWorker,
      onRestartWorker,
      onStartWorker,
      onStopWorker,
      onUpdateWorkerAvatar,
    }
  }

  test('stop passes the run id resolved from the agent (NOT the worker id)', () => {
    const { onStopWorker } = renderPane()
    fireEvent.click(within(openWorkerMenu('busy')).getByTestId('worker-card-stop-busy'))
    expect(onStopWorker).toHaveBeenCalledTimes(1)
    // A button wired to the worker id instead of the run id (a common mis-plumb)
    // would call with 'busy' here.
    expect(onStopWorker).toHaveBeenCalledWith('run-busy-77')
  })

  test('restart passes BOTH the worker id and the resolved run id', () => {
    const { onRestartWorker } = renderPane()
    fireEvent.click(within(openWorkerMenu('busy')).getByTestId('worker-card-restart-busy'))
    expect(onRestartWorker).toHaveBeenCalledTimes(1)
    expect(onRestartWorker).toHaveBeenCalledWith('busy', 'run-busy-77')
  })

  test('start (a no-run worker) still routes to onStartWorker', () => {
    const { onStartWorker } = renderPane({
      terminalRuns: [],
      workers: [worker({ id: 'idle1', name: 'idle-agent', status: 'idle' })],
    })
    fireEvent.click(within(openWorkerMenu('idle1')).getByTestId('worker-card-start-idle1'))
    expect(onStartWorker).toHaveBeenCalledWith(expect.objectContaining({ id: 'idle1' }))
  })

  test('create opens the add-worker affordance on mobile', () => {
    const onAddWorkerClick = vi.fn()
    renderMobile(
      withI18n(
        <WorkersPane
          onAddWorkerClick={onAddWorkerClick}
          onDeleteWorker={vi.fn()}
          onOpenShellTerminal={vi.fn()}
          onOpenWorker={vi.fn()}
          onRenameWorker={vi.fn(async () => ({ error: null }))}
          onUpdateWorkerAvatar={vi.fn(async () => ({ error: null }))}
          onStartWorker={vi.fn()}
          startingWorkerId={null}
          terminalRuns={[]}
          workers={[worker()]}
        />
      )
    )
    fireEvent.click(screen.getByTestId('add-worker-trigger'))
    expect(onAddWorkerClick).toHaveBeenCalledTimes(1)
  })

  test('avatar action can clear a custom avatar from the mobile sheet', async () => {
    const { onUpdateWorkerAvatar } = renderPane({
      terminalRuns: [],
      workers: [worker({ avatar: tinyAvatar, id: 'idle1', name: 'idle-agent', status: 'idle' })],
    })

    fireEvent.click(within(openWorkerMenu('idle1')).getByTestId('worker-card-avatar-idle1'))
    fireEvent.click(screen.getByText('Use default'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(onUpdateWorkerAvatar).toHaveBeenCalledWith('idle1', null)
    })
  })

  test('delete still routes through the confirm dialog and fires onDeleteWorker', () => {
    const { onDeleteWorker } = renderPane()
    fireEvent.click(within(openWorkerMenu('busy')).getByTestId('worker-card-delete-busy'))
    const confirm = within(document.body).getByText('Delete member')
    fireEvent.click(confirm)
    expect(onDeleteWorker).toHaveBeenCalledTimes(1)
    expect(onDeleteWorker).toHaveBeenCalledWith(expect.objectContaining({ id: 'busy' }))
  })
})
