// @vitest-environment jsdom
//
// M5b impl:terminal — bracketed-paste framing for the mobile paste-with-confirm
// flow. A confirmed paste must arrive at the PTY framed exactly like xterm's
// own paste so the agent's editor treats it as a literal block (no autoindent /
// no run-on-newline). An embedded end-marker must be stripped so the payload
// can't break out of the bracket.

import { describe, expect, test } from 'vitest'

import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  wrapBracketedPaste,
} from '../../web/src/terminal/bracketed-paste.js'

describe('wrapBracketedPaste', () => {
  test('wraps the payload in the start/end markers when mode is unknown', () => {
    const wrapped = wrapBracketedPaste('hello world')
    expect(wrapped).toBe(`${BRACKETED_PASTE_START}hello world${BRACKETED_PASTE_END}`)
  })

  test('wraps when bracketedPasteMode is explicitly true', () => {
    const wrapped = wrapBracketedPaste('x', { modes: { bracketedPasteMode: true } })
    expect(wrapped).toBe(`${BRACKETED_PASTE_START}x${BRACKETED_PASTE_END}`)
  })

  test('sends raw (no framing) when bracketedPasteMode is explicitly false', () => {
    const wrapped = wrapBracketedPaste('plain', { modes: { bracketedPasteMode: false } })
    expect(wrapped).toBe('plain')
  })

  test('strips an embedded end-marker so the payload cannot break out', () => {
    const malicious = `before${BRACKETED_PASTE_END}after`
    const wrapped = wrapBracketedPaste(malicious)
    expect(wrapped).toBe(`${BRACKETED_PASTE_START}beforeafter${BRACKETED_PASTE_END}`)
    // the only end-marker present is the trailing frame
    expect(wrapped.indexOf(BRACKETED_PASTE_END)).toBe(wrapped.length - BRACKETED_PASTE_END.length)
  })

  test('the markers are the canonical CSI 200~ / 201~ sequences', () => {
    expect(BRACKETED_PASTE_START).toBe('\x1b[200~')
    expect(BRACKETED_PASTE_END).toBe('\x1b[201~')
  })
})
