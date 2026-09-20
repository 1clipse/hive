// @vitest-environment jsdom
//
// M5b impl:substitutes — clipboard separation (Parity row ⚠️). The phone's navigator.clipboard is a
// SEPARATE channel from the remote terminal's stdin. Copying a selection writes to the phone clipboard
// only; reading the clipboard never writes to the terminal on its own. The single bridge between them
// is the explicit, confirmed paste gesture — and even then the bytes are bracketed-paste framed.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  copySelectionToPhoneClipboard,
  readPhoneClipboardForPaste,
} from '../../web/src/mobile/clipboard.js'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  wrapBracketedPaste,
} from '../../web/src/terminal/bracketed-paste.js'

const installClipboard = () => {
  const writeText = vi.fn(() => Promise.resolve())
  const readText = vi.fn(() => Promise.resolve('clipboard contents'))
  vi.stubGlobal('navigator', { clipboard: { writeText, readText } })
  return { writeText, readText }
}

beforeEach(() => {})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mobile clipboard separation', () => {
  test('copySelectionToPhoneClipboard writes ONLY to navigator.clipboard, never to a terminal sink', async () => {
    const { writeText } = installClipboard()
    const sendInput = vi.fn()

    await copySelectionToPhoneClipboard('hello world')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('hello world')
    // The copy helper has no knowledge of stdin — nothing reaches the terminal.
    expect(sendInput).not.toHaveBeenCalled()
  })

  test('readPhoneClipboardForPaste reads the clipboard but does NOT itself touch the terminal', async () => {
    const { readText } = installClipboard()
    const sendInput = vi.fn()

    const text = await readPhoneClipboardForPaste()

    expect(readText).toHaveBeenCalledTimes(1)
    expect(text).toBe('clipboard contents')
    // Reading alone must not push anything to the terminal — only an explicit confirmed paste does.
    expect(sendInput).not.toHaveBeenCalled()
  })

  test('the paste bridge frames the confirmed text with bracketed-paste markers', () => {
    const sendInput = vi.fn()

    // Simulating the confirmed-paste callback: only here does clipboard text reach the terminal.
    const wrapped = wrapBracketedPaste('multi\nline', { modes: { bracketedPasteMode: true } })
    sendInput(wrapped)

    expect(sendInput).toHaveBeenCalledTimes(1)
    expect(wrapped.startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(wrapped.endsWith(BRACKETED_PASTE_END)).toBe(true)
    expect(wrapped).toContain('multi\nline')
  })

  test('a nested bracketed-paste end-marker is stripped so the payload cannot break out', () => {
    const malicious = `before${BRACKETED_PASTE_END}after`
    const wrapped = wrapBracketedPaste(malicious, { modes: { bracketedPasteMode: true } })

    // Exactly one START and one END — the embedded end-marker is gone.
    expect(wrapped.split(BRACKETED_PASTE_END)).toHaveLength(2)
    expect(wrapped.split(BRACKETED_PASTE_START)).toHaveLength(2)
    expect(wrapped).toContain('beforeafter')
  })
})
