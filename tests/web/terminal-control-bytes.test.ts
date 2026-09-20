// @vitest-environment jsdom
//
// M5b impl:terminal — control-byte table for terminal command surfaces. Named
// keys resolve to the exact PTY byte sequence a CLI agent expects. Overlapping
// chords import SHORTCUT_BYTES so command surfaces and the desktop shortcut
// resolver can never diverge (no magic hex).

import { describe, expect, test } from 'vitest'

import { resolveControlBytes, type TerminalKeyName } from '../../web/src/terminal/control-bytes.js'
import { SHORTCUT_BYTES } from '../../web/src/terminal/shortcuts.js'

describe('resolveControlBytes — literal control keys', () => {
  const cases: Array<[TerminalKeyName, string]> = [
    ['esc', '\x1b'],
    ['tab', '\t'],
    ['enter', '\r'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
    ['ctrlC', '\x03'],
    ['ctrlD', '\x04'],
    ['ctrlZ', '\x1a'],
    ['ctrlL', '\x0c'],
    ['ctrlR', '\x12'],
    ['ctrlW', '\x17'],
  ]
  for (const [key, bytes] of cases) {
    test(`${key} -> ${JSON.stringify(bytes)}`, () => {
      expect(resolveControlBytes(key)).toBe(bytes)
    })
  }
})

describe('resolveControlBytes — overlapping chords reuse SHORTCUT_BYTES', () => {
  test('ctrlU is the readline kill-to-line-start byte', () => {
    expect(resolveControlBytes('ctrlU')).toBe(SHORTCUT_BYTES.killToLineStart)
    expect(resolveControlBytes('ctrlU')).toBe('\x15')
  })

  test('ctrlA is line-start', () => {
    expect(resolveControlBytes('ctrlA')).toBe(SHORTCUT_BYTES.lineStart)
    expect(resolveControlBytes('ctrlA')).toBe('\x01')
  })

  test('ctrlE is line-end', () => {
    expect(resolveControlBytes('ctrlE')).toBe(SHORTCUT_BYTES.lineEnd)
    expect(resolveControlBytes('ctrlE')).toBe('\x05')
  })
})

describe('resolveControlBytes — arrows respect application-cursor-keys mode', () => {
  test('normal mode emits CSI sequences (not swapped)', () => {
    expect(resolveControlBytes('arrowUp')).toBe('\x1b[A')
    expect(resolveControlBytes('arrowDown')).toBe('\x1b[B')
    expect(resolveControlBytes('arrowRight')).toBe('\x1b[C')
    expect(resolveControlBytes('arrowLeft')).toBe('\x1b[D')
  })

  test('left and right are distinct (catches a CSI swap)', () => {
    expect(resolveControlBytes('arrowLeft')).not.toBe(resolveControlBytes('arrowRight'))
  })

  test('application-cursor-keys mode emits SS3 sequences', () => {
    const ctx = { applicationCursorKeys: true }
    expect(resolveControlBytes('arrowUp', ctx)).toBe('\x1bOA')
    expect(resolveControlBytes('arrowDown', ctx)).toBe('\x1bOB')
    expect(resolveControlBytes('arrowRight', ctx)).toBe('\x1bOC')
    expect(resolveControlBytes('arrowLeft', ctx)).toBe('\x1bOD')
  })
})
