// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { RemotePairingConfirm } from '../../web/src/remote/RemotePairingConfirm.js'
import { RemoteFeatureProvider } from '../../web/src/remote/useRemoteFeature.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const confirmCalls: string[] = []
const rejectCalls: string[] = []

interface PendingOpts {
  pending: boolean
  sas?: string
  name?: string | null
  expiresInMs?: number
}

const stub = (opts: PendingOpts) => {
  const pendingRow = opts.pending
    ? [
        {
          pairing_id: 'pair-42',
          device_name: opts.name === undefined ? 'Pixel 9' : opts.name,
          sas: opts.sas ?? '481516',
          expires_at: Date.now() + (opts.expiresInMs ?? 120_000),
        },
      ]
    : []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    if (url.includes('/api/remote/status')) {
      return json({ enabled: true, logged_in: true, gateway_url: 'wss://gw', connected: true })
    }
    if (url.includes('/api/remote/pairings/pending')) return json(pendingRow)
    if (url.includes('/confirm') && method === 'POST') {
      confirmCalls.push(url)
      // Once confirmed, the next pending poll returns empty (dialog closes).
      pendingRow.length = 0
      return new Response(null, { status: 204 })
    }
    if (url.includes('/reject') && method === 'POST') {
      rejectCalls.push(url)
      pendingRow.length = 0
      return new Response(null, { status: 204 })
    }
    return json({})
  })
}

const renderConfirm = () =>
  render(
    <I18nProvider>
      <ToastProvider>
        <RemoteFeatureProvider>
          <RemotePairingConfirm />
        </RemoteFeatureProvider>
      </ToastProvider>
    </I18nProvider>
  )

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  confirmCalls.length = 0
  rejectCalls.length = 0
})

test('no dialog renders while there is no pending pairing', async () => {
  stub({ pending: false })
  renderConfirm()
  // Let the initial status + poll settle.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(screen.queryByTestId('remote-pairing-confirm')).toBeNull()
  expect(screen.queryByTestId('remote-pairing-confirm-action')).toBeNull()
})

test('renders device name + the 6-digit SAS when a pairing is pending', async () => {
  stub({ pending: true, sas: '481516', name: 'Pixel 9' })
  renderConfirm()

  const dialog = await screen.findByTestId('remote-pairing-confirm')
  expect(dialog).toHaveTextContent('Pixel 9')
  const sas = screen.getByTestId('remote-pairing-sas')
  expect(sas).toHaveTextContent('481516')
  expect(sas.textContent ?? '').toMatch(/^\d{6}$/)
})

test('Confirm calls confirmPairing exactly once and the dialog disappears', async () => {
  stub({ pending: true })
  renderConfirm()

  await screen.findByTestId('remote-pairing-confirm')
  fireEvent.click(screen.getByTestId('remote-pairing-confirm-action'))

  await waitFor(() => expect(confirmCalls.length).toBe(1))
  expect(confirmCalls[0]).toContain('/api/remote/pairings/pair-42/confirm')
  // No accidental reject.
  expect(rejectCalls).toEqual([])
  await waitFor(() => expect(screen.queryByTestId('remote-pairing-confirm')).toBeNull())
})

test('Reject calls rejectPairing — never confirm — and closes', async () => {
  stub({ pending: true })
  renderConfirm()

  await screen.findByTestId('remote-pairing-confirm')
  fireEvent.click(screen.getByTestId('remote-pairing-reject'))

  await waitFor(() => expect(rejectCalls.length).toBe(1))
  expect(rejectCalls[0]).toContain('/api/remote/pairings/pair-42/reject')
  expect(confirmCalls).toEqual([])
})

test('Escape closes via REJECT, not a neutral dismiss (no usable pairing left)', async () => {
  stub({ pending: true })
  renderConfirm()

  const dialog = await screen.findByTestId('remote-pairing-confirm')
  fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })

  await waitFor(() => expect(rejectCalls.length).toBe(1))
  expect(confirmCalls).toEqual([])
})

test('an expiry while the dialog is open auto-rejects', async () => {
  stub({ pending: true, expiresInMs: 5_000 })
  renderConfirm()

  await screen.findByTestId('remote-pairing-confirm')
  expect(rejectCalls).toEqual([])

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })

  await waitFor(() => expect(rejectCalls.length).toBe(1))
  expect(confirmCalls).toEqual([])
})
