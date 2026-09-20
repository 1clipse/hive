// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { RemoteDeviceView } from '../../web/src/api.js'
import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
} from '../../web/src/notifications/NotificationProvider.js'
import { RemoteSessionNotifications } from '../../web/src/notifications/RemoteSessionNotifications.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

let storage = new Map<string, string>()

class FakeAudio {
  preload = ''
  volume = 1

  constructor(readonly src: string) {}

  play() {
    return Promise.resolve()
  }
}

const installLocalStorage = () => {
  storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
}

const device = (overrides: Partial<RemoteDeviceView>): RemoteDeviceView => ({
  deviceId: 'device-1',
  name: "Shaokun's iPhone",
  lastActive: null,
  createdAt: 1_700_000_000_000,
  revoked: false,
  ...overrides,
})

const renderNotifications = (devices: RemoteDeviceView[]) =>
  render(
    <ToastProvider>
      <NotificationProvider>
        <RemoteSessionNotifications devices={devices} enabled />
        <Toaster />
      </NotificationProvider>
    </ToastProvider>
  )

const tree = (devices: RemoteDeviceView[], enabled = true) => (
  <ToastProvider>
    <NotificationProvider>
      <RemoteSessionNotifications devices={devices} enabled={enabled} />
      <Toaster />
    </NotificationProvider>
  </ToastProvider>
)

beforeEach(() => {
  installLocalStorage()
  window.localStorage.removeItem(NOTIFICATION_SETTINGS_KEY)
  Object.defineProperty(window, 'Audio', {
    configurable: true,
    value: FakeAudio,
  })
})

afterEach(() => {
  cleanup()
})

describe('remote session notifications', () => {
  test('seeds initial device state without emitting startup toasts', () => {
    renderNotifications([device({ deviceId: 'device-1' })])

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('notifies when a new remote device session appears', () => {
    const view = renderNotifications([device({ deviceId: 'device-1' })])

    view.rerender(
      tree([device({ deviceId: 'device-1' }), device({ deviceId: 'device-2', name: 'iPad' })])
    )

    expect(screen.getByTestId('toast')).toHaveTextContent('iPad connected')
  })

  test('does not re-notify for a device already present in the prior snapshot', () => {
    const view = renderNotifications([device({ deviceId: 'device-1' })])

    view.rerender(tree([device({ deviceId: 'device-1', lastActive: Date.now() })]))

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('a revoked device that drops off and re-appears active is treated as new', () => {
    // Device starts revoked (not "active"), then a fresh pairing re-adds it active.
    const view = renderNotifications([device({ deviceId: 'device-1', revoked: true })])

    view.rerender(tree([device({ deviceId: 'device-1', revoked: false })]))

    expect(screen.getByTestId('toast')).toHaveTextContent('connected')
  })

  test('stays silent while the remote feature is disabled even as devices appear', () => {
    const view = render(tree([device({ deviceId: 'device-1' })], false))

    view.rerender(tree([device({ deviceId: 'device-1' }), device({ deviceId: 'device-2' })], false))

    expect(screen.queryByTestId('toast')).toBeNull()
  })

  test('routes through the shared notify channel so the message honors detail settings', () => {
    // "detailed" makes notify() pick the detail string over brief; proves the
    // alert rides the existing settings-aware channel rather than a bespoke toast.
    window.localStorage.setItem(
      NOTIFICATION_SETTINGS_KEY,
      JSON.stringify({ desktop: false, detail: 'detailed', sound: 'off' })
    )
    const view = renderNotifications([device({ deviceId: 'device-1' })])

    view.rerender(
      tree([device({ deviceId: 'device-1' }), device({ deviceId: 'device-2', name: 'iPad' })])
    )

    expect(screen.getByTestId('toast')).toHaveTextContent('iPad established a remote session')
  })
})
