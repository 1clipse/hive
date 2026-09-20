// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { MobileReconnectBanner } from '../../web/src/mobile/MobileReconnectBanner.js'

const renderBanner = (status: Parameters<typeof MobileReconnectBanner>[0]['status']) =>
  render(
    <I18nProvider>
      <MobileReconnectBanner status={status} />
    </I18nProvider>
  )

afterEach(() => cleanup())

describe('MobileReconnectBanner', () => {
  test('renders a retry action for resumable disconnected tunnel state', () => {
    const retry = vi.fn()
    renderBanner({ state: 'disconnected', reason: 'daemon_offline', retry })

    expect(screen.getByTestId('mobile-reconnect-banner')).toHaveTextContent('Disconnected.')
    fireEvent.click(screen.getByTestId('mobile-reconnect-retry'))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test('does not show a fake retry action for automatic reconnect or revoked states', () => {
    const { rerender } = render(
      <I18nProvider>
        <MobileReconnectBanner status={{ state: 'reconnecting', nextRetryInMs: 1000 }} />
      </I18nProvider>
    )

    expect(screen.getByTestId('mobile-reconnect-banner')).toHaveTextContent('Reconnecting')
    expect(screen.queryByTestId('mobile-reconnect-retry')).toBeNull()

    rerender(
      <I18nProvider>
        <MobileReconnectBanner status={{ state: 'revoked' }} />
      </I18nProvider>
    )

    expect(screen.getByTestId('mobile-reconnect-banner')).toHaveTextContent('Access revoked')
    expect(screen.queryByTestId('mobile-reconnect-retry')).toBeNull()
  })
})
