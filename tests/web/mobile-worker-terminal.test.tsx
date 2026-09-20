// @vitest-environment jsdom
//
// M5b impl:wiring — Parity row "worker terminal view + input (writable)". On a
// phone the WorkerModal full-screen PTY view must be WRITABLE, not read-only.
// Input now goes directly through xterm (no mobile-only composer strip). The
// reversed product (read-only worker terminal) would never surface xterm input
// and never send to the live /io socket.

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { LayoutModeProvider } from '../../web/src/mobile/layout-mode.js'
import { TerminalView } from '../../web/src/terminal/TerminalView.js'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  readonly OPEN = 1
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  sent: Array<string | Uint8Array> = []
  constructor(readonly url: string) {
    MockWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = this.OPEN
      this.onopen?.()
    })
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  deliver(data: string) {
    this.onmessage?.({ data })
  }
  send(payload: string | Uint8Array) {
    if (this.readyState !== this.OPEN) return
    this.sent.push(payload)
  }
}

let latestOnDataHandler: ((chunk: string) => void) | undefined

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    get buffer() {
      return {
        active: { baseY: 0, type: 'normal', viewportY: 0 },
        onBufferChange() {
          return { dispose() {} }
        },
      }
    }
    get modes() {
      return { applicationCursorKeysMode: false, mouseTrackingMode: 'none' }
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    loadAddon() {}
    onData(handler: (chunk: string) => void) {
      latestOnDataHandler = handler
      return { dispose() {} }
    }
    onBinary() {
      return { dispose() {} }
    }
    onScroll() {
      return { dispose() {} }
    }
    hasSelection() {
      return false
    }
    getSelection() {
      return ''
    }
    clearSelection() {}
    open() {}
    write(_chunk?: string, callback?: () => void) {
      callback?.()
    }
    scrollToBottom() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket as never)
})

afterEach(() => {
  cleanup()
  MockWebSocket.instances = []
  latestOnDataHandler = undefined
  vi.unstubAllGlobals()
})

// Mirrors WorkerModal's slot: id `worker-pty-${runId}` with data-pty-slot="worker".
const addWorkerSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `worker-pty-${runId}`
  slot.dataset.ptySlot = 'worker'
  document.body.appendChild(slot)
  return slot
}

const ioSocketSends = () =>
  MockWebSocket.instances
    .find((socket) => new URL(socket.url).pathname.endsWith('/io'))
    ?.sent.map(String) ?? []

const restoreTerminal = async () => {
  await waitFor(() => {
    expect(
      MockWebSocket.instances.some((socket) => new URL(socket.url).pathname.endsWith('/control'))
    ).toBe(true)
  })
  MockWebSocket.instances
    .find((socket) => new URL(socket.url).pathname.endsWith('/control'))
    ?.deliver(JSON.stringify({ type: 'restore', snapshot: '' }))
}

test('mobile: the worker PTY view is writable — xterm input reaches the worker /io socket', async () => {
  addWorkerSlot('run-worker-1')
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode: 'mobile' }}>
        <TerminalView runId="run-worker-1" title="Worker" />
      </LayoutModeProvider>
    </I18nProvider>
  )

  await restoreTerminal()
  await waitFor(() => {
    expect(document.querySelector('[data-testid="terminal-run-worker-1"]')).toBeTruthy()
    expect(latestOnDataHandler).toBeDefined()
  })
  expect(document.querySelector('[data-testid="mobile-terminal-controls"]')).toBeNull()
  expect(document.querySelector('[data-testid="terminal-keybar"]')).toBeNull()
  expect(document.querySelector('[data-testid="termkey-ctrlC"]')).toBeNull()

  latestOnDataHandler?.('npm test\r')

  await waitFor(() => {
    expect(ioSocketSends()).toContain('npm test\r')
  })
})

test('desktop: the worker PTY view shows NO mobile controls (zero-regression)', async () => {
  addWorkerSlot('run-worker-wide')
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode: 'wide' }}>
        <TerminalView runId="run-worker-wide" title="Worker" />
      </LayoutModeProvider>
    </I18nProvider>
  )
  await waitFor(() => {
    expect(document.querySelector('[data-testid="terminal-run-worker-wide"]')).toBeTruthy()
  })
  expect(document.querySelector('[data-testid="mobile-terminal-controls"]')).toBeNull()
  expect(document.querySelector('[data-testid="terminal-composer-input"]')).toBeNull()
})
