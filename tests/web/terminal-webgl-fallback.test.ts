// @vitest-environment jsdom
//
// M5b impl:terminal — WebGL detection drives the renderer choice. Some mobile
// browsers expose no stable WebGL context; loading the addon there white-screens
// the terminal. detectWebglSupport must be honest: an injected canvas whose
// getContext returns null => false; a truthy context => true. Inverted detection
// (reporting support when none exists) is the bug this test bites.

import { describe, expect, test } from 'vitest'

import { detectWebglSupport } from '../../web/src/terminal/webgl-support.js'

const canvasWith = (getContext: unknown): HTMLCanvasElement =>
  ({ getContext }) as unknown as HTMLCanvasElement

describe('detectWebglSupport', () => {
  test('false when there is no canvas factory', () => {
    expect(detectWebglSupport(() => null)).toBe(false)
  })

  test('false when getContext is not a function', () => {
    expect(detectWebglSupport(() => canvasWith(undefined))).toBe(false)
  })

  test('false when getContext returns null for both webgl2 and webgl', () => {
    expect(detectWebglSupport(() => canvasWith(() => null))).toBe(false)
  })

  test('true when getContext yields a webgl2 context', () => {
    const ctx = {}
    expect(
      detectWebglSupport(() => canvasWith((id: string) => (id === 'webgl2' ? ctx : null)))
    ).toBe(true)
  })

  test('true when only the legacy webgl context is available', () => {
    const ctx = {}
    expect(
      detectWebglSupport(() => canvasWith((id: string) => (id === 'webgl' ? ctx : null)))
    ).toBe(true)
  })

  test('false when getContext throws (no crash propagated)', () => {
    expect(
      detectWebglSupport(() =>
        canvasWith(() => {
          throw new Error('context creation failed')
        })
      )
    ).toBe(false)
  })
})
