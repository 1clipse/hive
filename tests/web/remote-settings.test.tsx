// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { AppProviders } from '../../web/src/AppProviders.js'
import { SettingsMenu } from '../../web/src/settings/SettingsMenu.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface RemoteState {
  enabled: boolean
  logged_in: boolean
  gateway_url: string | null
  connected: boolean
}

const enabledPuts: boolean[] = []

const stubFetch = (initial: RemoteState, putOk = true) => {
  const state = { ...initial }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.includes('/api/remote/status')) return json(state)
    if (url.includes('/api/remote/enabled') && method === 'PUT') {
      if (!putOk) return json({ error: 'boom' }, 500)
      state.enabled = (JSON.parse(String(init?.body ?? '{}')) as { enabled: boolean }).enabled
      enabledPuts.push(state.enabled)
      return json(state)
    }
    if (url.includes('/api/remote/pairings/pending')) return json([])
    if (url.includes('/api/remote/devices')) return json([])
    if (url.includes('/api/remote/audit')) return json([])
    // Workflow GET the SettingsMenu also fires.
    return json({ enabled: false })
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  enabledPuts.length = 0
})

test('remote access is OFF by default — no device list or Add device rendered', async () => {
  stubFetch({ enabled: false, logged_in: false, gateway_url: null, connected: false })
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )
  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const toggle = await screen.findByTestId('settings-toggle-remote')
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(toggle).not.toBeChecked()
  // While off, nothing below the switch renders.
  expect(screen.queryByTestId('settings-remote-add-device')).toBeNull()
  expect(screen.queryByTestId('remote-device-list')).toBeNull()
  expect(screen.queryByTestId('remote-login-status')).toBeNull()
})

test('turning remote access on calls setRemoteEnabled and surfaces status + Add device', async () => {
  stubFetch({ enabled: false, logged_in: true, gateway_url: 'wss://gw.example', connected: true })
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )
  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const toggle = await screen.findByTestId('settings-toggle-remote')
  await waitFor(() => expect(toggle).not.toBeDisabled())

  fireEvent.click(toggle)

  await waitFor(() => expect(enabledPuts).toContain(true))
  await waitFor(() => expect(toggle).toBeChecked())
  // Linked + Add device appear once enabled.
  expect(await screen.findByTestId('remote-login-status')).toHaveTextContent('gw.example')
  expect(screen.getByTestId('settings-remote-add-device')).toBeInTheDocument()
})

test('login-status copy switches between linked and not-linked', async () => {
  // Enabled but NOT logged in: Add device is hidden, the not-linked hint shows.
  stubFetch({ enabled: true, logged_in: false, gateway_url: null, connected: false })
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )
  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const status = await screen.findByTestId('remote-login-status')
  expect(status).toHaveTextContent(/not linked/i)
  expect(screen.queryByTestId('settings-remote-add-device')).toBeNull()
})

test('a failed enable save surfaces an error and leaves the toggle off', async () => {
  stubFetch({ enabled: false, logged_in: true, gateway_url: 'wss://gw', connected: false }, false)
  render(
    <AppProviders>
      <SettingsMenu />
    </AppProviders>
  )
  fireEvent.click(screen.getByTestId('topbar-app-settings'))
  const toggle = await screen.findByTestId('settings-toggle-remote')
  await waitFor(() => expect(toggle).not.toBeDisabled())

  fireEvent.click(toggle)

  await waitFor(() =>
    expect(screen.getByTestId('remote-access-section')).toHaveTextContent(/Could not save/i)
  )
  expect(enabledPuts).toEqual([])
  expect(toggle).not.toBeChecked()
})
