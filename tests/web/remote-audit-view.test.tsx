// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { RemoteAuditView } from '../../web/src/remote/RemoteAuditView.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const stub = (rows: unknown[], opts: { ok?: boolean } = {}) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/remote/audit')) {
      if (opts.ok === false) return json({ error: 'boom' }, 500)
      return json(rows)
    }
    return json({})
  })
}

const renderView = () =>
  render(
    <I18nProvider>
      <RemoteAuditView />
    </I18nProvider>
  )

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('the audit stream is collapsed by default and loads on expand', async () => {
  stub([
    {
      id: 1,
      device_id: null,
      ts: 1,
      workspace_id: null,
      action: 'session_open',
      endpoint: null,
      result: 'ok',
      reject_reason: null,
      byte_count: null,
      preview: null,
    },
  ])
  renderView()

  // Collapsed: no rows yet.
  expect(screen.queryByTestId('remote-audit-row-1')).toBeNull()
  fireEvent.click(screen.getByTestId('remote-audit-toggle'))
  expect(await screen.findByTestId('remote-audit-row-1')).toBeInTheDocument()
})

test('a rejected row shows its reject reason in the error color', async () => {
  stub([
    {
      id: 7,
      device_id: null,
      ts: 1,
      workspace_id: null,
      action: 'reject',
      endpoint: '/api/remote/pairings/x/confirm',
      result: 'rejected',
      reject_reason: 'pairing_confirm_forbidden',
      byte_count: null,
      preview: null,
    },
  ])
  renderView()

  fireEvent.click(screen.getByTestId('remote-audit-toggle'))
  const row = await screen.findByTestId('remote-audit-row-7')
  expect(row).toHaveTextContent('pairing_confirm_forbidden')
  // The result cell is rendered in the error color (not the neutral ok styling).
  expect(row.querySelector('[style*="--status-red"]')).not.toBeNull()
})

test('a ws_input row shows the bounded preview and byte count; ok rows show no reason', async () => {
  stub([
    {
      id: 9,
      device_id: 'dev-1',
      ts: 2,
      workspace_id: 'ws',
      action: 'ws_input',
      endpoint: '/ws/terminal/run/io',
      result: 'ok',
      reject_reason: null,
      byte_count: 12,
      preview: 'ls -la',
    },
  ])
  renderView()

  fireEvent.click(screen.getByTestId('remote-audit-toggle'))
  const row = await screen.findByTestId('remote-audit-row-9')
  expect(row).toHaveTextContent('ls -la')
  expect(row).toHaveTextContent('12 bytes')
  // ok rows do not carry a reject reason suffix.
  expect(row.textContent).not.toContain('null')
})

test('empty + error states', async () => {
  stub([])
  const { unmount } = renderView()
  fireEvent.click(screen.getByTestId('remote-audit-toggle'))
  await waitFor(() =>
    expect(screen.getByTestId('remote-audit-view')).toHaveTextContent(/no remote activity/i)
  )
  unmount()
  cleanup()

  stub([], { ok: false })
  renderView()
  fireEvent.click(screen.getByTestId('remote-audit-toggle'))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
})
