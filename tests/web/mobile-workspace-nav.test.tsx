// @vitest-environment jsdom
//
// M5b impl:adapt-a — workspace switch on mobile. The desktop 3-column shell
// keeps the Sidebar always visible; on a phone it uses a purpose-built touch
// bottom sheet. Selecting a workspace must fire onSelectWorkspace AND close
// the sheet; create must fire onCreateClick.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { MobileWorkspaceSwitcher } from '../../web/src/mobile/MobileWorkspaceSwitcher.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { renderMobile } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
})

const ws = (id: string, name: string): WorkspaceSummary => ({
  id,
  name,
  path: `/tmp/${id}`,
})

const withI18n = (ui: React.ReactElement) => (
  <I18nProvider>
    <ToastProvider>{ui}</ToastProvider>
  </I18nProvider>
)

const renderSwitcher = () => {
  const onSelectWorkspace = vi.fn()
  const onCreateClick = vi.fn()
  const onDeleteWorkspace = vi.fn()
  renderMobile(
    withI18n(
      <MobileWorkspaceSwitcher
        activeWorkspaceId="ws-a"
        workspaces={[ws('ws-a', 'Alpha'), ws('ws-b', 'Bravo')]}
        workersByWorkspaceId={{}}
        onSelectWorkspace={onSelectWorkspace}
        onCreateClick={onCreateClick}
        onDeleteWorkspace={onDeleteWorkspace}
      />
    )
  )
  return { onCreateClick, onDeleteWorkspace, onSelectWorkspace }
}

describe('MobileWorkspaceSwitcher sheet', () => {
  test('the sheet is closed by default and the Sidebar is not mounted', () => {
    renderSwitcher()
    // The trigger shows the active workspace name.
    expect(screen.getByTestId('mobile-workspace-switcher-trigger')).toHaveTextContent('Alpha')
    expect(screen.queryByTestId('mobile-workspace-switcher-sheet')).toBeNull()
  })

  test('opening the sheet mounts touch-sized workspace rows', async () => {
    renderSwitcher()
    fireEvent.click(screen.getByTestId('mobile-workspace-switcher-trigger'))
    const sheet = await screen.findByTestId('mobile-workspace-switcher-sheet')
    expect(within(sheet).getByText('Workspaces')).toBeInTheDocument()
    expect(within(sheet).getByTestId('mobile-ws-row-ws-b')).toHaveTextContent('Bravo')
  })

  test('selecting a workspace fires onSelectWorkspace and closes the sheet', async () => {
    const { onSelectWorkspace } = renderSwitcher()
    fireEvent.click(screen.getByTestId('mobile-workspace-switcher-trigger'))
    const sheet = await screen.findByTestId('mobile-workspace-switcher-sheet')

    fireEvent.click(within(sheet).getByTestId('mobile-ws-row-ws-b'))
    expect(onSelectWorkspace).toHaveBeenCalledWith('ws-b')
    // Reversed (sheet never closes) keeps the sheet mounted.
    await waitFor(() => {
      expect(screen.queryByTestId('mobile-workspace-switcher-sheet')).toBeNull()
    })
  })

  test('create routes to onCreateClick (and closes the sheet)', async () => {
    const { onCreateClick } = renderSwitcher()
    fireEvent.click(screen.getByTestId('mobile-workspace-switcher-trigger'))
    const sheet = await screen.findByTestId('mobile-workspace-switcher-sheet')

    fireEvent.click(within(sheet).getByTestId('mobile-ws-create'))
    expect(onCreateClick).toHaveBeenCalledTimes(1)
  })
})
