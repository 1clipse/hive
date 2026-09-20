// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { RemoteFeatureProvider, useRemoteFeature } from '../../web/src/remote/useRemoteFeature.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { renderMobile } from './helpers/mobile-render.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let pendingFetches = 0

const stub = (status: {
  enabled: boolean
  logged_in: boolean
  gateway_url: string | null
  connected: boolean
}) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/remote/status')) return json(status)
    if (url.includes('/api/remote/pairings/pending')) {
      pendingFetches += 1
      return json([
        { pairing_id: 'p', device_name: 'Phone', sas: '000111', expires_at: Date.now() + 60_000 },
      ])
    }
    return json({})
  })
}

// Tiny probe component that surfaces the hook's pending + connection state into the DOM.
const Probe = () => {
  const { pending, status } = useRemoteFeature()
  return (
    <>
      <div data-testid="probe">{pending ? pending.sas : 'none'}</div>
      <div data-testid="conn">{status.connection}</div>
    </>
  )
}

const renderProbe = () =>
  render(
    <I18nProvider>
      <ToastProvider>
        <RemoteFeatureProvider>
          <Probe />
        </RemoteFeatureProvider>
      </ToastProvider>
    </I18nProvider>
  )

const renderMobileProbe = () =>
  renderMobile(
    <I18nProvider>
      <ToastProvider>
        <RemoteFeatureProvider>
          <Probe />
        </RemoteFeatureProvider>
      </ToastProvider>
    </I18nProvider>
  )

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  pendingFetches = 0
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('no poll is armed while remote access is OFF — pending stays null', async () => {
  stub({ enabled: false, logged_in: true, gateway_url: 'wss://gw', connected: false })
  renderProbe()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })

  expect(pendingFetches).toBe(0)
  expect(screen.getByTestId('probe')).toHaveTextContent('none')
})

test('no poll is armed while logged out (enabled but not linked)', async () => {
  stub({ enabled: true, logged_in: false, gateway_url: null, connected: false })
  renderProbe()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })

  expect(pendingFetches).toBe(0)
  expect(screen.getByTestId('probe')).toHaveTextContent('none')
})

test('enabled + linked arms the poll and surfaces the pending pairing', async () => {
  stub({ enabled: true, logged_in: true, gateway_url: 'wss://gw', connected: true })
  renderProbe()

  // Let the initial status load settle, then run the immediate poll tick.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })

  expect(pendingFetches).toBeGreaterThanOrEqual(1)
  expect(screen.getByTestId('probe')).toHaveTextContent('000111')

  // Subsequent interval ticks keep polling.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100)
  })
  expect(pendingFetches).toBeGreaterThanOrEqual(2)
})

test('mobile keeps pending pairing desktop-only and does not poll the approval endpoint', async () => {
  stub({ enabled: true, logged_in: true, gateway_url: 'wss://gw', connected: true })
  renderMobileProbe()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })

  expect(pendingFetches).toBe(0)
  expect(screen.getByTestId('probe')).toHaveTextContent('none')
})

test('the poll re-pulls status so the connection state stays fresh (not a one-shot)', async () => {
  let conn = 'connecting'
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/remote/status')) {
      return json({
        enabled: true,
        logged_in: true,
        gateway_url: 'wss://gw',
        connected: conn === 'online',
        connection: conn,
      })
    }
    if (url.includes('/api/remote/pairings/pending')) return json([])
    return json({})
  })
  renderProbe()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(screen.getByTestId('conn')).toHaveTextContent('connecting')

  // The tunnel comes online — a later poll tick MUST reflect it. A one-shot initial fetch (the old
  // behavior) would leave the dot stuck on 'connecting'.
  conn = 'online'
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100)
  })
  expect(screen.getByTestId('conn')).toHaveTextContent('online')
})
