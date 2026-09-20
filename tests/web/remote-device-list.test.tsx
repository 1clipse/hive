// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { RemoteDeviceList } from '../../web/src/remote/RemoteDeviceList.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const revokeCalls: string[] = []

const stub = (devices: unknown[], opts: { listOk?: boolean } = {}) => {
  let current = devices
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.includes('/revoke') && method === 'POST') {
      revokeCalls.push(url)
      // Closed loop: the revoked device drops out of the next list fetch.
      const id = url.split('/devices/')[1]?.split('/revoke')[0]
      current = current.filter((d) => (d as { id: string }).id !== id)
      return new Response(null, { status: 204 })
    }
    if (url.includes('/api/remote/devices')) {
      if (opts.listOk === false) return json({ error: 'boom' }, 500)
      return json(current)
    }
    return json({})
  })
}

const renderList = () =>
  render(
    <I18nProvider>
      <ToastProvider>
        <RemoteDeviceList />
      </ToastProvider>
    </I18nProvider>
  )

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  revokeCalls.length = 0
})

test('renders paired device rows', async () => {
  stub([
    { id: 'dev-1', name: 'iPhone', last_active: Date.now(), created_at: 1, revoked_at: null },
    { id: 'dev-2', name: 'Pixel', last_active: null, created_at: 2, revoked_at: null },
  ])
  renderList()

  expect(await screen.findByTestId('remote-device-dev-1')).toHaveTextContent('iPhone')
  expect(screen.getByTestId('remote-device-dev-2')).toHaveTextContent('Pixel')
})

test('Revoke requires a confirm, then calls revokeRemoteDevice and re-fetches', async () => {
  stub([{ id: 'dev-1', name: 'iPhone', last_active: null, created_at: 1, revoked_at: null }])
  renderList()

  await screen.findByTestId('remote-device-dev-1')
  fireEvent.click(screen.getByTestId('remote-device-revoke-dev-1'))

  // A confirm dialog gates the destructive action — no API call yet.
  expect(revokeCalls).toEqual([])
  const confirm = await screen.findByTestId('confirm-content')
  expect(confirm).toHaveTextContent('iPhone')

  fireEvent.click(screen.getByTestId('confirm-action'))

  await waitFor(() => expect(revokeCalls.length).toBe(1))
  expect(revokeCalls[0]).toContain('/api/remote/devices/dev-1/revoke')
  // The row is gone after the re-fetch (closed loop reflected in the list).
  await waitFor(() => expect(screen.queryByTestId('remote-device-dev-1')).toBeNull())
})

test('never renders raw session-key material in the DOM', async () => {
  // Even if the server (wrongly) attached key fields, the view maps only the
  // metadata projection, so nothing key-shaped reaches the DOM.
  stub([
    {
      id: 'dev-1',
      name: 'iPhone',
      last_active: null,
      created_at: 1,
      revoked_at: null,
      key_d2p: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      key_p2d: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  ])
  const { container } = renderList()
  await screen.findByTestId('remote-device-dev-1')
  expect(container.textContent).not.toContain('AAAAAAAAAAA')
  expect(container.textContent).not.toContain('BBBBBBBBBBB')
})

test('empty state when there are no paired devices', async () => {
  stub([])
  renderList()
  await waitFor(() =>
    expect(screen.getByTestId('remote-device-list')).toHaveTextContent(/no paired devices/i)
  )
})

test('surfaces a load error', async () => {
  stub([], { listOk: false })
  renderList()
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
})
