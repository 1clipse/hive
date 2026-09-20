// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { Topbar } from '../../web/src/layout/Topbar.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

describe('Topbar version update hint', () => {
  test('shows an update badge and install hint when a newer version is available', () => {
    render(
      <Topbar
        hideActions
        version="0.6.0-alpha.3"
        versionInfo={{
          canRunHiveUpdate: false,
          currentVersion: '0.6.0-alpha.3',
          installHint: 'pnpm add -g @tt-a1i/hive@latest',
          installSource: 'pnpm-global',
          latestVersion: '0.6.0-alpha.4',
          packageName: '@tt-a1i/hive',
          releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          updateNote:
            'Hive appears to be installed through pnpm; update it with pnpm so npm does not create a shadow global install.',
          updateAvailable: true,
        }}
      />
    )

    expect(screen.getByTestId('topbar-logo')).toHaveAttribute('src', '/logo.png')
    expect(screen.getByTestId('topbar-update-badge')).toHaveTextContent('Update available')
    expect(screen.getByText('v0.6.0-alpha.3 → v0.6.0-alpha.4')).toBeInTheDocument()
    expect(screen.getByText('pnpm add -g @tt-a1i/hive@latest')).toBeInTheDocument()
    expect(screen.getByTestId('topbar-open-release')).toHaveAttribute(
      'href',
      'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4'
    )
  })

  test('copies the install-source-aware update command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <Topbar
        hideActions
        version="0.6.0-alpha.3"
        versionInfo={{
          canRunHiveUpdate: true,
          currentVersion: '0.6.0-alpha.3',
          installHint: 'hive update',
          installSource: 'npm-global',
          latestVersion: '0.6.0-alpha.4',
          packageName: '@tt-a1i/hive',
          releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          updateNote: 'Hive appears to be installed through npm.',
          updateAvailable: true,
        }}
      />
    )

    fireEvent.click(screen.getByTestId('topbar-copy-update-command'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hive update'))
    await waitFor(() =>
      expect(screen.getByTestId('topbar-copy-update-command')).toHaveAttribute(
        'aria-label',
        'Update command copied'
      )
    )
  })

  test('surfaces a copy failure when the clipboard API is unavailable', async () => {
    render(
      <Topbar
        hideActions
        version="0.6.0-alpha.3"
        versionInfo={{
          canRunHiveUpdate: true,
          currentVersion: '0.6.0-alpha.3',
          installHint: 'hive update',
          installSource: 'npm-global',
          latestVersion: '0.6.0-alpha.4',
          packageName: '@tt-a1i/hive',
          releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          updateNote: 'Hive appears to be installed through npm.',
          updateAvailable: true,
        }}
      />
    )

    fireEvent.click(screen.getByTestId('topbar-copy-update-command'))

    await waitFor(() =>
      expect(screen.getByTestId('topbar-copy-update-command')).toHaveAttribute(
        'aria-label',
        'Could not copy update command'
      )
    )
  })

  test('does not render a copy command for an unknown install source', () => {
    render(
      <Topbar
        hideActions
        version="0.6.0-alpha.3"
        versionInfo={{
          canRunHiveUpdate: false,
          currentVersion: '0.6.0-alpha.3',
          installHint: '',
          installSource: 'unknown',
          latestVersion: '0.6.0-alpha.4',
          packageName: '@tt-a1i/hive',
          releaseUrl: 'https://www.npmjs.com/package/@tt-a1i/hive/v/0.6.0-alpha.4',
          updateNote:
            'Hive could not determine how this process was installed; update it with the same package manager and install target you originally used.',
          updateAvailable: true,
        }}
      />
    )

    expect(screen.getByTestId('topbar-update-badge')).toHaveTextContent('Update available')
    expect(screen.queryByTestId('topbar-copy-update-command')).not.toBeInTheDocument()
    expect(screen.queryByText('npm install -g @tt-a1i/hive@latest')).not.toBeInTheDocument()
    expect(screen.getByText(/same package manager and install target/)).toBeInTheDocument()
  })

  test('logo + version link out to the hivehq.dev site in a new tab', () => {
    render(
      <Topbar
        hideActions
        version="1.4.1"
        versionInfo={{
          canRunHiveUpdate: true,
          currentVersion: '1.4.1',
          installHint: '',
          installSource: 'npm-global',
          latestVersion: '1.4.1',
          packageName: '@tt-a1i/hive',
          releaseUrl: '',
          updateNote: '',
          updateAvailable: false,
        }}
      />
    )

    const link = screen.getByTestId('topbar-brand-link')
    expect(link).toHaveAttribute('href', 'https://hivehq.dev')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // Both the logo and the version sit inside the link, so clicking either
    // navigates to the site — that's the whole point of the request.
    expect(link).toContainElement(screen.getByTestId('topbar-logo'))
    expect(link).toHaveTextContent('Hive')
    expect(link).toHaveTextContent('v1.4.1')
  })
})
