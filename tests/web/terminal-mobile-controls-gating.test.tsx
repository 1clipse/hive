// @vitest-environment jsdom
//
// Mobile writable terminals use the raw xterm input path directly. The retired
// mobile composer/keybar strip must stay absent on both desktop and mobile.

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

const addSlot = (runId: string) => {
  const slot = document.createElement('div')
  slot.id = `orch-pty-${runId}`
  slot.dataset.ptySlot = 'orchestrator'
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

test('desktop (wide) terminal renders NO mobile controls', async () => {
  addSlot('run-wide')
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode: 'wide' }}>
        <TerminalView runId="run-wide" title="Orch" />
      </LayoutModeProvider>
    </I18nProvider>
  )
  await waitFor(() => {
    expect(document.querySelector('[data-testid="terminal-run-wide"]')).toBeTruthy()
  })
  expect(document.querySelector('[data-testid="mobile-terminal-controls"]')).toBeNull()
  expect(document.querySelector('[data-testid="terminal-keybar"]')).toBeNull()
  expect(document.querySelector('[data-testid="termkey-esc"]')).toBeNull()
})

test('mobile terminal stays chrome-free and raw xterm input reaches sendInput', async () => {
  addSlot('run-mobile')
  render(
    <I18nProvider>
      <LayoutModeProvider value={{ mode: 'mobile' }}>
        <TerminalView runId="run-mobile" title="Orch" />
      </LayoutModeProvider>
    </I18nProvider>
  )

  await restoreTerminal()
  await waitFor(() => {
    expect(document.querySelector('[data-testid="terminal-run-mobile"]')).toBeTruthy()
    expect(latestOnDataHandler).toBeDefined()
  })
  expect(document.querySelector('[data-testid="mobile-terminal-controls"]')).toBeNull()
  expect(document.querySelector('[data-testid="terminal-keybar"]')).toBeNull()
  expect(document.querySelector('[data-testid="termkey-esc"]')).toBeNull()

  latestOnDataHandler?.('whoami\r')

  await waitFor(() => {
    expect(ioSocketSends()).toContain('whoami\r')
  })
})
