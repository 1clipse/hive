// @vitest-environment jsdom
//
// M5b impl:substitutes — the add-workspace local-capability substitute (Parity row ⚠️).
//
// On mobile the OS folder picker (`/api/fs/pick-folder`) would pop a native dialog on the HOST
// machine over the tunnel — a phone user can't see or dismiss it. So the mobile add-workspace flow
// MUST use the server-side browse + probe + manual-path surface instead and NEVER call pickFolder.
//
// The adversarial pair:
//   - mobile  → AddWorkspaceFlow routes to ServerBrowseAddWorkspace → /api/fs/browse + /api/fs/probe,
//               typing a manual path + create fires POST /api/workspaces with that path,
//               and pickFolder is NEVER called.
//   - wide    → AddWorkspaceFlow routes to AddWorkspaceDialog → pickFolder IS called (proves the
//               gate is real, not just "nothing happens on mobile").

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { AddWorkspaceFlow } from '../../web/src/workspace/AddWorkspaceFlow.js'

const json = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

interface FetchCall {
  url: string
  method: string
  body: unknown
}

// Stub the global fetch (apiFetch rides it) AND spy on the api.pickFolder export through the module
// boundary — a phone reusing AddWorkspaceDialog would fire pickFolder() from its mount effect, so the
// spy bites whether the OS dialog request rides fetch or a direct export call.
const stubFetch = (): FetchCall[] => {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const u = new URL(url, 'http://127.0.0.1')
    const method = init?.method ?? 'GET'
    let parsed: unknown
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = init.body
      }
    }
    calls.push({ url: u.pathname, method, body: parsed })

    if (u.pathname === '/api/fs/browse') {
      return json({
        current_path: '/sandbox',
        root_path: '/sandbox',
        parent_path: null,
        entries: [],
        error: null,
        ok: true,
      })
    }
    if (u.pathname === '/api/fs/probe') {
      const q = u.searchParams.get('path') ?? ''
      return json({
        current_branch: null,
        exists: true,
        is_dir: true,
        is_git_repository: false,
        ok: true,
        path: q,
        suggested_name: q.split(/[\\/]/).filter(Boolean).pop() ?? '',
      })
    }
    if (u.pathname === '/api/command-presets') {
      return json([
        { args: [], available: true, command: 'claude', displayName: 'Claude Code', id: 'claude' },
      ])
    }
    if (u.pathname === '/api/fs/pick-folder') {
      // A phone must never hit this; if it does, the negative assertions below fail.
      return json({ canceled: true, error: null, path: null, probe: null, supported: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  return calls
}

const renderFlow = (mode: 'mobile' | 'wide', ui: ReactElement) =>
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode }}>{ui}</LayoutModeProvider>
    </I18nProvider>
  )

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mobile add-workspace substitute (no pick-folder)', () => {
  test('mobile flow browses + probes + creates with a typed path and NEVER calls pick-folder', async () => {
    const calls = stubFetch()
    const pickSpy = vi.spyOn(api, 'pickFolder')
    const onCreate = vi.fn(() => Promise.resolve())

    renderFlow('mobile', <AddWorkspaceFlow trigger={1} onClose={() => {}} onCreate={onCreate} />)

    // The manual-path field is the headline mobile surface — it must be reachable without first
    // expanding a hidden "advanced" toggle (HARDEN major: expanded by default on mobile).
    const manual = await screen.findByTestId('fs-manual-path')
    fireEvent.change(manual, { target: { value: '/sandbox/alpha' } })

    const nameInput = await screen.findByTestId('fs-preview-name-input')
    fireEvent.change(nameInput, { target: { value: 'Alpha' } })

    const createBtn = await screen.findByTestId('add-workspace-create')
    await waitFor(() => expect((createBtn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(createBtn)

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alpha', path: '/sandbox/alpha' })
    )

    // Negative: pick-folder is never invoked, neither as an export nor as a fetch.
    expect(pickSpy).not.toHaveBeenCalled()
    expect(calls.some((c) => c.url === '/api/fs/pick-folder')).toBe(false)

    // Positive: the substitute surface actually browsed + probed.
    expect(calls.some((c) => c.url === '/api/fs/browse')).toBe(true)
    expect(calls.some((c) => c.url === '/api/fs/probe')).toBe(true)
  })

  test('wide flow DOES call pick-folder (proves the mobile gate is a real branch)', async () => {
    stubFetch()
    const pickSpy = vi.spyOn(api, 'pickFolder')

    renderFlow(
      'wide',
      <AddWorkspaceFlow trigger={1} onClose={() => {}} onCreate={() => Promise.resolve()} />
    )

    await waitFor(() => expect(pickSpy).toHaveBeenCalledTimes(1))
  })
})
