// @vitest-environment jsdom
//
// M5b impl:adapt-b — hive update / runtime-restart prompts must reach the user
// on mobile too. The UpdateAvailableToast bottom banner is offset above the
// bottom nav on mobile (data-mobile + CSS) so it isn't hidden behind the nav.
// Parity row: "hive update / runtime restart". Desktop banner unchanged.

import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import * as registerSw from '../../web/src/pwa/register-service-worker.js'
import { UpdateAvailableToast } from '../../web/src/pwa/UpdateAvailableToast.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Drive the toast into its visible state: fire the SW-update subscription
// callback synchronously with an apply fn.
const armUpdate = () => {
  vi.spyOn(registerSw, 'subscribeServiceWorkerUpdate').mockImplementation((cb) => {
    cb(() => {})
    return () => {}
  })
}

const withI18n = (ui: React.ReactElement) => <I18nProvider>{ui}</I18nProvider>

describe('mobile update prompt — reachable + offset above nav', () => {
  test('mobile update toast renders and tags data-mobile', () => {
    armUpdate()
    renderMobile(withI18n(<UpdateAvailableToast terminalRuns={[]} />))
    const toast = screen.getByTestId('update-available-toast')
    expect(toast).toHaveAttribute('data-mobile', 'true')
    // The reload action must be reachable (no working runs → enabled).
    expect(screen.getByTestId('update-available-reload')).toBeTruthy()
  })

  test('desktop update toast does NOT tag data-mobile (zero-regression)', () => {
    armUpdate()
    renderWide(withI18n(<UpdateAvailableToast terminalRuns={[]} />))
    expect(screen.getByTestId('update-available-toast')).not.toHaveAttribute('data-mobile')
  })
})
