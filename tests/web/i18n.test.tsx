// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { AppProviders } from '../../web/src/AppProviders.js'
import { Topbar } from '../../web/src/layout/Topbar.js'
import { UI_LANGUAGE_STORAGE_KEY } from '../../web/src/uiLanguage.js'
import { WelcomePane } from '../../web/src/worker/WelcomePane.js'

const versionInfo = {
  canRunHiveUpdate: true,
  currentVersion: '0.6.0-alpha.5',
  installHint: 'npm install -g @tt-a1i/hive@latest',
  installSource: 'npm-global',
  latestVersion: '0.6.0-alpha.5',
  packageName: '@tt-a1i/hive',
  releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/hive',
  updateNote: 'Hive appears to be installed through npm.',
  updateAvailable: false,
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('UI language switcher', () => {
  test('switches shell copy to Chinese and persists the choice', () => {
    render(
      <AppProviders>
        <Topbar version="0.6.0-alpha.5" versionInfo={versionInfo} />
        <WelcomePane onAddWorkspace={() => {}} />
      </AppProviders>
    )

    expect(screen.getByText('Welcome to Hive')).toBeInTheDocument()

    // Open settings menu and switch language
    fireEvent.click(screen.getByTestId('topbar-app-settings'))
    fireEvent.click(screen.getByRole('button', { name: '中文' }))

    expect(screen.getByText('欢迎使用 Hive')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /添加第一个 Workspace/ })).toBeInTheDocument()
    expect(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('zh')

    // Verification we can switch back
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByText('Welcome to Hive')).toBeInTheDocument()
  })

  test('still switches for the current session when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    render(
      <AppProviders>
        <Topbar version="0.6.0-alpha.5" versionInfo={versionInfo} />
        <WelcomePane onAddWorkspace={() => {}} />
      </AppProviders>
    )

    // Open settings menu and switch language
    fireEvent.click(screen.getByTestId('topbar-app-settings'))
    fireEvent.click(screen.getByRole('button', { name: '中文' }))

    expect(screen.getByText('欢迎使用 Hive')).toBeInTheDocument()
  })
})
