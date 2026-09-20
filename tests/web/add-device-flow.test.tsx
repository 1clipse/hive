// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  encodePairingPayload,
  REMOTE_CRYPTO_VERSION,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { AddDeviceFlow } from '../../web/src/remote/AddDeviceFlow.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// A known PairingPayload (valid 32-byte secret) the server still returns for compatibility. The
// desktop UI no longer renders it; users type the short code instead.
const QR = encodePairingPayload({
  v: REMOTE_CRYPTO_VERSION,
  gatewayUrl: 'wss://gw.example/relay',
  daemonId: 'daemon-abc',
  pairingSecret: toBase64Url(new Uint8Array(32).fill(9)),
})
const CODE = 'ABCD-EFGH-JK23'

const startCalls: string[] = []

const stubStart = (expiresInMs: number, startOk = true) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/remote/pairings') && (init?.method ?? 'GET') === 'POST') {
      startCalls.push(url)
      if (!startOk) return json({ error: 'nope' }, 503)
      return json({
        pairing_id: 'pair-1',
        qr: QR,
        code: CODE,
        expires_at: Date.now() + expiresInMs,
      })
    }
    return json({})
  })
}

const renderFlow = () =>
  render(
    <I18nProvider>
      <AddDeviceFlow />
    </I18nProvider>
  )

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  startCalls.length = 0
})

test('Add device starts a pairing and shows the pairing code + countdown', async () => {
  stubStart(120_000)
  renderFlow()

  fireEvent.click(screen.getByTestId('settings-remote-add-device'))

  await waitFor(() => expect(screen.getByTestId('remote-qr-panel')).toBeInTheDocument())
  expect(startCalls.length).toBe(1)
  expect(screen.getByTestId('remote-pair-code')).toHaveTextContent(CODE)
  expect(screen.getByTestId('remote-qr-countdown')).toHaveTextContent(/120s|119s/)
})

test('the desktop pairing panel does not render the raw payload or internal handle', async () => {
  stubStart(120_000)
  const { container } = renderFlow()

  fireEvent.click(screen.getByTestId('settings-remote-add-device'))
  await waitFor(() => expect(screen.getByTestId('remote-pair-code')).toBeInTheDocument())

  // The compatibility payload / base64 secret and internal handle stay out of the rendered panel.
  expect(container.textContent).not.toContain(QR)
  expect(container.textContent).not.toContain(toBase64Url(new Uint8Array(32).fill(9)))
  expect(container.textContent).not.toContain('pair-1')
})

test('Cancel collapses the QR panel back to the Add device button', async () => {
  stubStart(120_000)
  renderFlow()

  fireEvent.click(screen.getByTestId('settings-remote-add-device'))
  await waitFor(() => expect(screen.getByTestId('remote-qr-panel')).toBeInTheDocument())

  fireEvent.click(screen.getByTestId('remote-qr-cancel'))

  expect(screen.queryByTestId('remote-qr-panel')).toBeNull()
  expect(screen.getByTestId('settings-remote-add-device')).toBeInTheDocument()
})

test('the QR shows an expired notice once the TTL elapses', async () => {
  stubStart(3_000)
  renderFlow()

  fireEvent.click(screen.getByTestId('settings-remote-add-device'))
  await waitFor(() => expect(screen.getByTestId('remote-qr-panel')).toBeInTheDocument())
  expect(screen.queryByTestId('remote-qr-expired')).toBeNull()

  await act(async () => {
    vi.advanceTimersByTime(4_000)
  })

  expect(screen.getByTestId('remote-qr-expired')).toBeInTheDocument()
  // The code is gone once expired.
  expect(screen.queryByTestId('remote-pair-code')).toBeNull()
})

test('a failed start surfaces an error and shows no QR', async () => {
  stubStart(120_000, false)
  renderFlow()

  fireEvent.click(screen.getByTestId('settings-remote-add-device'))

  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(screen.queryByTestId('remote-qr-panel')).toBeNull()
})
