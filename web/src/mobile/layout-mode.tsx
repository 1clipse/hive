import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react'

/**
 * The breakpoint below which Hive switches from the desktop 3-column shell to
 * the touch-first MobileShell. Responsive, not device-sniffed: a narrow
 * desktop window also gets the mobile layout, which is acceptable and keeps the
 * transport axis (gateway vs. localhost) completely independent of layout.
 */
export const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)'

export interface LayoutMode {
  mode: 'wide' | 'mobile'
}

// Default 'wide' is the zero-regression guarantee: the existing suite renders
// <App/> with no LayoutModeProvider at the breakpoint, so every
// `isMobile ? mobile : desktop` ternary collapses to the desktop branch.
const LayoutModeContext = createContext<LayoutMode>({ mode: 'wide' })

const WIDE: LayoutMode = { mode: 'wide' }
const MOBILE: LayoutMode = { mode: 'mobile' }

type MatchMediaImpl = (query: string) => MediaQueryList

/**
 * useSyncExternalStore-backed matchMedia reader. Tear-free + deterministic
 * (no resize listener). With no matchMedia (SSR / a host that doesn't expose
 * it) it falls back to wide. The implementation is injectable so we can mirror
 * is-standalone.ts and stay env-safe.
 */
const useMatchMediaMode = (
  matchMediaImpl: MatchMediaImpl | undefined = typeof window !== 'undefined'
    ? window.matchMedia.bind(window)
    : undefined
): LayoutMode => {
  const subscribe = (onChange: () => void): (() => void) => {
    if (!matchMediaImpl) return () => {}
    const mql = matchMediaImpl(MOBILE_BREAKPOINT_QUERY)
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }
  const getSnapshot = (): LayoutMode => {
    if (!matchMediaImpl) return WIDE
    return matchMediaImpl(MOBILE_BREAKPOINT_QUERY).matches ? MOBILE : WIDE
  }
  // No matchMedia on the server → wide.
  return useSyncExternalStore(subscribe, getSnapshot, () => WIDE)
}

export const LayoutModeProvider = ({
  children,
  value,
}: {
  children: ReactNode
  value?: LayoutMode
}) => {
  // When `value` is provided (tests, or an explicit mount) use it verbatim;
  // otherwise derive from matchMedia. The hook must run unconditionally to keep
  // the hook order stable, so we always compute the derived value.
  const derived = useMatchMediaMode()
  return (
    <LayoutModeContext.Provider value={value ?? derived}>{children}</LayoutModeContext.Provider>
  )
}

export const useLayoutMode = (): LayoutMode => useContext(LayoutModeContext)

// Convenience aliases — DO NOT create separate hooks; these wrap useLayoutMode.
export const useIsMobile = (): boolean => useLayoutMode().mode === 'mobile'
// alias for the terminal task's import name; must be the SAME function.
export const useIsMobileLayout = useIsMobile
