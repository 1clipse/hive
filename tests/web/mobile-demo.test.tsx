// @vitest-environment jsdom
//
// M5b impl:wiring — Parity row "Demo mode" on mobile. Demo is a pure client
// path that must be reachable from the phone shell, not just the desktop
// 3-column tree. With the breakpoint matchMedia matching, <App/> renders the
// MobileShell; entering demo (via the manifest shortcut entry / Try Demo CTA in
// the welcome pane it hosts) must surface the demo workspace inside that shell.
// Reversed (demo gated behind a desktop-only entry) → no demo-banner on mobile.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { startTestServer } from '../helpers/test-server.js'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    loadAddon() {}
    onData() {
      return { dispose() {} }
    }
    open() {}
    write(_chunk?: string, callback?: () => void) {
      callback?.()
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}))

let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let serverBaseUrl = ''
let uiCookie = ''

// Force the mobile breakpoint so <App/>'s matchMedia-derived LayoutModeProvider
// resolves to { mode: 'mobile' } and AppInner takes the MobileShell branch.
const stubMobileMatchMedia = () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent() {
          return false
        },
      }) as unknown as MediaQueryList
  )
}

beforeEach(async () => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  stubMobileMatchMedia()
  const server = await startTestServer()
  cleanupServer = server.close
  serverBaseUrl = server.baseUrl
  await nativeFetch(`${server.baseUrl}/api/ui/session`).then((response) => {
    uiCookie = response.headers.get('set-cookie') ?? ''
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${serverBaseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', uiCookie)
    return nativeFetch(url, { ...init, headers })
  })
  vi.stubGlobal(
    'WebSocket',
    class {
      readonly OPEN = 1
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      readyState = 3
      close() {}
      send() {}
    } as never
  )
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await cleanupServer?.()
  cleanupServer = undefined
  window.localStorage?.clear?.()
})

test('mobile: Try Demo enters demo mode inside the MobileShell', async () => {
  render(<App />)

  // The phone shell is what frames the welcome pane.
  await waitFor(() => {
    expect(document.querySelector('[data-mobile-shell="true"]')).toBeTruthy()
  })
  await screen.findByTestId('welcome-pane')

  fireEvent.click(screen.getByRole('button', { name: /try the demo/i }))

  // Demo workspace renders inside the same mobile shell — not a desktop-only entry.
  expect(screen.getByTestId('demo-banner')).toBeInTheDocument()
  expect(screen.getByTestId('demo-replay-panel')).toBeInTheDocument()
  expect(document.querySelector('[data-mobile-shell="true"]')).toBeTruthy()
})
