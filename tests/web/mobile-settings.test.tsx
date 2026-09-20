// @vitest-environment jsdom
//
// M5b impl:adapt-b — the Settings popover becomes a full-screen sheet on
// mobile, but the BODY (experimental toggles, webhook field, Remote section
// with device list + revoke) is the same set of components — no field is
// dropped. Parity rows: "settings (webhook/experimental/Remote)" and
// "device mgmt (list+revoke)".
//
// It ALSO enforces the trust-root boundary inside the Remote section: the
// AddDeviceFlow / QR-generation affordance is a desktop-only surface (it mints
// a new pairing — the trust root). On mobile that affordance must NOT render,
// while the equal-authority device list + revoke MUST still render. This is
// the SettingsMenu-side half of the new-device-approval ❌ row (the top-level
// RemotePairingConfirm half is covered by mobile-no-pairing-approval.test).

import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { NotificationProvider } from '../../web/src/notifications/NotificationProvider.js'
import { RemoteFeatureProvider } from '../../web/src/remote/useRemoteFeature.js'
import { SettingsMenu } from '../../web/src/settings/SettingsMenu.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LINKED_STATUS: api.RemoteStatus = {
  enabled: true,
  loggedIn: true,
  gatewayUrl: 'https://gw.example',
  connected: true,
  connection: 'online',
}

beforeEach(() => {
  vi.spyOn(api, 'getRemoteStatus').mockResolvedValue(LINKED_STATUS)
  vi.spyOn(api, 'getPendingPairing').mockResolvedValue(null)
  vi.spyOn(api, 'listRemoteDevices').mockResolvedValue([
    {
      deviceId: 'dev-1',
      name: 'Pixel 9',
      lastActive: null,
      revoked: false,
    } as api.RemoteDeviceView,
  ])
  vi.spyOn(api, 'listRemoteAudit').mockResolvedValue([])
  vi.spyOn(api, 'getWebhookUrl').mockResolvedValue('')
})

const renderSettings = (mode: 'mobile' | 'wide') => {
  const ui = (
    <I18nProvider>
      <ToastProvider>
        <NotificationProvider>
          <RemoteFeatureProvider>
            <SettingsMenu />
          </RemoteFeatureProvider>
        </NotificationProvider>
      </ToastProvider>
    </I18nProvider>
  )
  const result = mode === 'mobile' ? renderMobile(ui) : renderWide(ui)
  // Open the menu.
  screen.getByTestId('topbar-app-settings').click()
  return result
}

describe('mobile Settings sheet — body reachable', () => {
  test('mobile settings renders as a full-screen sheet (data-mobile), webhook + workflow toggle + Remote present', async () => {
    renderSettings('mobile')
    const menu = await screen.findByTestId('app-settings-menu')
    // Reversed (popover container kept on mobile) would leave it absolutely
    // positioned at top-8 right-0 width-360 — unscrollable + clipped on a phone.
    expect(menu).toHaveAttribute('data-mobile', 'true')

    expect(screen.getByTestId('settings-webhook-url')).toBeTruthy()
    expect(screen.getByTestId('settings-toggle-workflows')).toBeTruthy()
    expect(screen.getByTestId('remote-access-section')).toBeTruthy()
    // The sheet must offer a way back (a phone has no outside-click target).
    expect(screen.getByTestId('mobile-settings-close')).toBeTruthy()
  })

  test('desktop settings stays a popover (no data-mobile, no sheet close button)', async () => {
    renderSettings('wide')
    const menu = await screen.findByTestId('app-settings-menu')
    expect(menu).not.toHaveAttribute('data-mobile')
    expect(screen.queryByTestId('mobile-settings-close')).toBeNull()
  })
})

describe('Remote section — trust-root surface (Add device) hidden on mobile', () => {
  test('mobile Remote section hides AddDeviceFlow / QR while keeping device list + revoke', async () => {
    renderSettings('mobile')
    await screen.findByTestId('remote-access-section')
    // device list (equal authority) must be reachable
    const deviceList = await screen.findByTestId('remote-device-list')
    expect(within(deviceList).getByTestId('remote-device-revoke-dev-1')).toBeTruthy()

    // The Add-device button mints a NEW pairing (desktop trust root). It must
    // not be exposed remotely — a 403 dead button is also a UX cut. Reversed
    // (rendering AddDeviceFlow on mobile) would surface this testid.
    expect(screen.queryByTestId('settings-remote-add-device')).toBeNull()
    expect(screen.queryByTestId('remote-qr-panel')).toBeNull()
  })

  test('desktop Remote section DOES expose AddDeviceFlow (the intentional difference)', async () => {
    renderSettings('wide')
    await screen.findByTestId('remote-access-section')
    // Positive control: on the desktop trust root the affordance is present.
    expect(await screen.findByTestId('settings-remote-add-device')).toBeTruthy()
    // And the device list/revoke are still there too.
    const deviceList = await screen.findByTestId('remote-device-list')
    expect(within(deviceList).getByTestId('remote-device-revoke-dev-1')).toBeTruthy()
  })
})

describe('Remote master switch — revoke confirm closes loop on mobile', () => {
  test('mobile revoke opens the confirm dialog and confirm calls revokeRemoteDevice', async () => {
    const revoke = vi.spyOn(api, 'revokeRemoteDevice').mockResolvedValue(undefined)
    renderSettings('mobile')
    const revokeBtn = await screen.findByTestId('remote-device-revoke-dev-1')
    revokeBtn.click()
    const confirm = await screen.findByTestId('confirm-action')
    confirm.click()
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('dev-1'))
  })
})
