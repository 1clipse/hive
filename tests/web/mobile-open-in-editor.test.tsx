// @vitest-environment jsdom
//
// M5b impl:substitutes — open-in-editor (Parity row ⚠️). The action runs on the HOST (it dispatches
// the editor on the machine the daemon is on, NOT the phone). On mobile a phone user has no other
// signal that anything happened, so we surface a SUCCESS toast naming the workspace. Desktop stays
// quiet on success (existing behavior — the editor window appearing IS the feedback).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { WorkspaceSummary } from '../../src/shared/types.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { OpenWorkspaceButton } from '../../web/src/workspace/OpenWorkspaceButton.js'
import { PREFERRED_OPEN_TARGET_STORAGE_KEY } from '../../web/src/workspace/open-targets.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface OpenCall {
  url: string
  method: string
  body: unknown
}

const stubOpenFetch = (responder: (call: OpenCall) => Response | Promise<Response>): OpenCall[] => {
  const calls: OpenCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call: OpenCall = { url, method: init?.method ?? 'GET', body }
    calls.push(call)
    return responder(call)
  })
  return calls
}

const renderHarness = (mode: 'mobile' | 'wide', children: ReactNode) =>
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode }}>
        <ToastProvider>
          {children}
          <Toaster />
        </ToastProvider>
      </LayoutModeProvider>
    </I18nProvider>
  )

const mkWorkspace = (overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id: 'ws-1',
  name: 'Alpha',
  path: '/Users/admin/code/alpha',
  ...overrides,
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('mobile open-in-editor', () => {
  test('mobile invoke dispatches on the host AND shows a success toast naming the workspace', async () => {
    const calls = stubOpenFetch(() => json({ ok: true, effective_target_id: 'finder' }, 200))

    renderHarness('mobile', <OpenWorkspaceButton workspace={mkWorkspace({ name: 'Alpha' })} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    // The action runs on the host — same POST as desktop, never a phone-local navigation.
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('/api/workspaces/ws-1/open')

    // The phone gets a result toast (success copy contains the workspace name).
    const toaster = await screen.findByTestId('toaster')
    expect(toaster.textContent).toContain('Alpha')
  })

  test('desktop (wide) stays quiet on success — no toast', async () => {
    const calls = stubOpenFetch(() => json({ ok: true, effective_target_id: 'finder' }, 200))

    renderHarness('wide', <OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))
    await waitFor(() => expect(calls).toHaveLength(1))

    // No success toast on desktop (the editor window opening IS the feedback).
    expect(screen.queryByTestId('toaster')).toBeNull()
  })

  test('mobile still surfaces an error toast on failure (error path shared with desktop)', async () => {
    window.localStorage.setItem(PREFERRED_OPEN_TARGET_STORAGE_KEY, 'cursor')
    stubOpenFetch(() =>
      json({ ok: false, effective_target_id: 'cursor', error_code: 'app-not-installed' }, 502)
    )

    renderHarness('mobile', <OpenWorkspaceButton workspace={mkWorkspace()} />)

    fireEvent.click(screen.getByTestId('topbar-open-workspace'))

    const toaster = await screen.findByTestId('toaster')
    expect(toaster.textContent).toContain('Cursor')
  })
})
