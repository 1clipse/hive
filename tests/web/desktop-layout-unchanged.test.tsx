// @vitest-environment jsdom
//
// M5b impl:shell — DESKTOP ZERO-REGRESSION. With a wide breakpoint the app must
// render the existing 3-column shell (topbar blueprint button, the workspace
// sidebar title, an interactive resizer) and NONE of the mobile chrome
// (data-mobile-shell / bottom nav). A flipped conditional (mobile at wide)
// or MobileShell swallowing the wide path fails here.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { App } from '../../web/src/app.js'
import { APP_VERSION } from '../../web/src/version.js'
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

const tempDirs: string[] = []
let cleanupServer: (() => Promise<void>) | undefined
const nativeFetch = globalThis.fetch
let baseUrl = ''
let cookie = ''

beforeEach(async () => {
  window.localStorage?.clear?.()
  window.localStorage.setItem('hive.first-run-seen', '1')
  window.localStorage.setItem('hive.last-seen-version', APP_VERSION)
  // Wide breakpoint: the (max-width:767px) query never matches.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
  )
  const server = await startTestServer()
  cleanupServer = server.close
  baseUrl = server.baseUrl
  await nativeFetch(`${baseUrl}/api/ui/session`).then((response) => {
    cookie = response.headers.get('set-cookie') ?? ''
  })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const value =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = value.startsWith('http') ? value : `${baseUrl}${value}`
    const headers = new Headers(init?.headers)
    headers.set('cookie', cookie)
    return nativeFetch(url, { ...init, headers })
  })
  vi.stubGlobal(
    'WebSocket',
    class {
      readonly OPEN = 1
      onopen: (() => void) | null = null
      onmessage: ((e: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      readyState = 3
      close() {}
      send() {}
    } as never
  )
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await cleanupServer?.()
  cleanupServer = undefined
  window.localStorage?.clear?.()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const seedWorkspace = async (name: string) => {
  const workspacePath = mkdtempSync(join(tmpdir(), `hive-desktop-${name}-`))
  tempDirs.push(workspacePath)
  await nativeFetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, path: workspacePath, autostart_orchestrator: false }),
  })
}

describe('desktop layout unchanged at the wide breakpoint', () => {
  test('renders the existing 3-column shell and no mobile chrome', async () => {
    await seedWorkspace('alpha')
    render(<App />)

    // An active workspace makes the topbar actions (incl. the blueprint/Todo
    // button) appear — proving the desktop Topbar still renders.
    const blueprint = await screen.findByTestId('topbar-blueprint')
    expect(blueprint).toBeInTheDocument()
    expect(screen.getByTestId('workspace-sidebar-title')).toHaveTextContent('Workspaces')

    // The resizer is an interactive separator (begins a drag on mousedown).
    const separator = screen.getByRole('separator', { name: 'Resize Workspace sidebar' })
    expect(separator).toHaveAttribute('aria-valuenow')
    fireEvent.mouseDown(separator, { clientX: 56 })
    fireEvent.mouseMove(document, { clientX: 280 })
    await waitFor(() => {
      expect(separator).toHaveAttribute('aria-valuenow', '280')
    })
    fireEvent.mouseUp(document)

    // No mobile chrome leaked into the wide tree.
    expect(screen.queryByTestId('mobile-shell')).toBeNull()
    expect(screen.queryByTestId('mobile-bottom-nav')).toBeNull()
    expect(document.querySelector('[data-mobile-shell]')).toBeNull()
  })

  test('empty wide first-run also stays desktop (no mobile chrome)', async () => {
    render(<App />)
    await screen.findByTestId('welcome-pane')
    expect(screen.queryByTestId('mobile-shell')).toBeNull()
    expect(screen.queryByTestId('mobile-bottom-nav')).toBeNull()
    // The desktop sidebar still renders even on an empty workspace list.
    expect(screen.getByTestId('workspace-sidebar-title')).toBeInTheDocument()
  })
})
