// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest'

import { eventMatchesShortcut, type Shortcut } from '../../web/src/useGlobalShortcuts.js'

const shortcut = (input: Omit<Shortcut, 'handler'>): Shortcut => ({
  ...input,
  handler: vi.fn(),
})

const ev = (
  key: string,
  modifiers: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
): KeyboardEvent =>
  new KeyboardEvent('keydown', {
    altKey: modifiers.alt ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    key,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
  })

describe('eventMatchesShortcut', () => {
  test('matches the Windows/Linux Ctrl+Shift shortcut when no extra modifier is pressed', () => {
    expect(
      eventMatchesShortcut(
        ev('N', { ctrl: true, shift: true }),
        shortcut({ key: 'n', mod: true, shift: true }),
        false
      )
    ).toBe(true)
  })

  test('does not treat Windows AltGr as a Ctrl shortcut', () => {
    expect(
      eventMatchesShortcut(
        ev('N', { alt: true, ctrl: true, shift: true }),
        shortcut({ key: 'n', mod: true, shift: true }),
        false
      )
    ).toBe(false)
  })

  test('allows explicit Alt shortcuts when a caller opts in', () => {
    expect(
      eventMatchesShortcut(
        ev('N', { alt: true, ctrl: true, shift: true }),
        shortcut({ alt: true, key: 'n', mod: true, shift: true }),
        false
      )
    ).toBe(true)
  })
})
