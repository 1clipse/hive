// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  NOTIFICATION_SETTINGS_KEY,
  NotificationProvider,
  useNotifications,
} from '../../web/src/notifications/NotificationProvider.js'
import { NotificationSettingsButton } from '../../web/src/notifications/NotificationSettingsButton.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const notifications: Array<{ body: string | undefined; title: string }> = []
const playedAudioSources: string[] = []
let storage = new Map<string, string>()

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

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>()

  constructor(title: string, options?: NotificationOptions) {
    notifications.push({ body: options?.body, title })
  }
}

class FakeAudio {
  preload = ''
  volume = 1

  constructor(readonly src: string) {}

  play() {
    playedAudioSources.push(this.src)
    return Promise.resolve()
  }
}

const wrap = (children: ReactNode) => (
  <ToastProvider>
    <NotificationProvider>
      {children}
      <Toaster />
    </NotificationProvider>
  </ToastProvider>
)

const PushNotification = () => {
  const { notify } = useNotifications()
  return (
    <button
      type="button"
      data-testid="notify"
      onClick={() =>
        notify({
          brief: 'ember-check-23 reported',
          detail: 'ember-check-23 reported in mco.',
          kind: 'success',
          title: 'Member report',
        })
      }
    >
      notify
    </button>
  )
}

beforeEach(() => {
  installLocalStorage()
  notifications.length = 0
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockClear()
  FakeNotification.requestPermission.mockImplementation(async () => {
    FakeNotification.permission = 'granted'
    return 'granted'
  })
  playedAudioSources.length = 0
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: FakeNotification,
  })
  Object.defineProperty(window, 'Audio', {
    configurable: true,
    value: FakeAudio,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('notification settings', () => {
  test('persists selected sound and information detail', () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    expect(screen.getByRole('radiogroup', { name: 'Sound' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Cascade/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Detailed/ }))

    const saved = JSON.parse(window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY) ?? '{}')
    expect(saved.sound).toBe('cascade')
    expect(saved.detail).toBe('detailed')
  })

  test('previews a longer sound without selecting it', () => {
    render(wrap(<NotificationSettingsButton />))

    fireEvent.click(screen.getByTestId('topbar-settings'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview Cascade sound' }))

    const saved = JSON.parse(window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY) ?? '{}')
    expect(saved.sound).toBe('soft')
    expect(playedAudioSources).toEqual(['/sounds/hive-cascade.ogg'])
  })

  test('uses detailed copy, selected sound, and browser notification when enabled', async () => {
    render(
      wrap(
        <>
          <NotificationSettingsButton />
          <PushNotification />
        </>
      )
    )

    fireEvent.click(screen.getByTestId('topbar-settings'))
    fireEvent.click(screen.getByRole('radio', { name: /Tap/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Detailed/ }))
    fireEvent.click(screen.getByLabelText('Browser notifications'))

    await waitFor(() => expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('notify'))

    expect(screen.getByTestId('toast')).toHaveTextContent('ember-check-23 reported in mco.')
    expect(notifications).toEqual([
      {
        body: 'ember-check-23 reported in mco.',
        title: 'Member report',
      },
    ])
    expect(playedAudioSources).toEqual(['/sounds/hive-ping.ogg'])
  })
})
