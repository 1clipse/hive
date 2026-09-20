// @vitest-environment jsdom
//
// M5b impl:shell — the single shared layout-mode context. Everything in the
// mobile layer gates on this; its DEFAULT must be 'wide' so the existing suite
// (rendered with no provider, jsdom default width) collapses every
// `isMobile ? mobile : desktop` ternary to the desktop branch.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  LayoutModeProvider,
  MOBILE_BREAKPOINT_QUERY,
  useIsMobile,
  useIsMobileLayout,
  useLayoutMode,
} from '../../web/src/mobile/layout-mode.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ModeProbe = () => {
  const { mode } = useLayoutMode()
  const isMobile = useIsMobile()
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="is-mobile">{String(isMobile)}</span>
    </div>
  )
}

describe('layout-mode context', () => {
  test('defaults to wide with no provider (protects the existing suite)', () => {
    render(<ModeProbe />)
    // The reverse of this (default 'mobile') would flip every adapted
    // component to its mobile branch under the existing 1671 suite.
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
    expect(screen.getByTestId('is-mobile')).toHaveTextContent('false')
  })

  test('an explicit wide provider stays wide', () => {
    render(
      <LayoutModeProvider value={{ mode: 'wide' }}>
        <ModeProbe />
      </LayoutModeProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
    expect(screen.getByTestId('is-mobile')).toHaveTextContent('false')
  })

  test('an explicit mobile provider reports mobile', () => {
    render(
      <LayoutModeProvider value={{ mode: 'mobile' }}>
        <ModeProbe />
      </LayoutModeProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('mobile')
    expect(screen.getByTestId('is-mobile')).toHaveTextContent('true')
  })

  test('useIsMobileLayout is the same hook as useIsMobile (alias, not a fork)', () => {
    expect(useIsMobileLayout).toBe(useIsMobile)
  })

  test('derives mobile from a matchMedia that matches the breakpoint query', () => {
    const listeners: Array<() => void> = []
    const matchMedia = vi.fn((query: string) => {
      // The bite: a wrong query string here would silently never match a
      // real phone — assert the exact breakpoint query is the one consulted.
      expect(query).toBe(MOBILE_BREAKPOINT_QUERY)
      return {
        matches: true,
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
        removeEventListener: () => {},
      } as unknown as MediaQueryList
    })
    vi.stubGlobal('matchMedia', matchMedia)

    // No `value` prop → the provider derives the mode from matchMedia.
    render(
      <LayoutModeProvider>
        <ModeProbe />
      </LayoutModeProvider>
    )
    expect(matchMedia).toHaveBeenCalled()
    expect(screen.getByTestId('mode')).toHaveTextContent('mobile')
    void listeners
  })

  test('derives wide from a non-matching matchMedia', () => {
    const matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
    vi.stubGlobal('matchMedia', matchMedia)

    render(
      <LayoutModeProvider>
        <ModeProbe />
      </LayoutModeProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('wide')
  })
})
