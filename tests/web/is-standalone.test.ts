import { describe, expect, test } from 'vitest'

import { isStandalonePwa } from '../../web/src/pwa/is-standalone.js'

const mediaResult = (matches: boolean): MediaQueryList => ({ matches }) as unknown as MediaQueryList

describe('isStandalonePwa', () => {
  test('returns true when the standalone display-mode media query matches', () => {
    expect(
      isStandalonePwa((query) => {
        expect(query).toBe('(display-mode: standalone)')
        return mediaResult(true)
      }, false)
    ).toBe(true)
  })

  test('returns true on iOS Safari home-screen installs', () => {
    // iOS Safari never adopted display-mode; the legacy navigator.standalone
    // flag is the only signal there. We must accept it even when the
    // standard matchMedia query reports false.
    expect(isStandalonePwa(() => mediaResult(false), true)).toBe(true)
  })

  test('returns false in a regular browser tab', () => {
    expect(isStandalonePwa(() => mediaResult(false), false)).toBe(false)
  })

  test('returns false when neither signal is available', () => {
    // Server-side rendering or any host that doesn't expose matchMedia at all
    // also has no navigator.standalone. Must default to false rather than
    // throw — the shortcut layer treats this as "not installed."
    expect(isStandalonePwa(undefined, undefined)).toBe(false)
  })

  test('ignores navigator.standalone when matchMedia already returned true', () => {
    // Defense in depth: returning true on either signal is enough; we
    // don't want false from one source to negate true from the other.
    expect(isStandalonePwa(() => mediaResult(true), false)).toBe(true)
  })
})
