import { useEffect, useState } from 'react'

/**
 * On iOS Safari only: tracks visualViewport height so the shell shrinks when
 * the on-screen keyboard appears (iOS has no interactive-widget support).
 * When the keyboard closes and vv.height ≈ window.innerHeight, snaps back to
 * null so a stuck-short state from a missed final resize self-heals.
 *
 * On Android and every other platform this always returns null — the viewport
 * meta interactive-widget=resizes-content already shrinks the layout viewport
 * natively; applying an inline px height on top fights it and causes jitter.
 *
 * Callers fall back to h-dvh when null, so SSR / jsdom renders unchanged.
 */

// Conservative iOS detect: navigator.platform leads on older OS, UA as fallback.
// Avoids triggering on Android Chrome which also ships visualViewport.
const isIOS = (): boolean =>
  typeof navigator !== 'undefined' &&
  /iP(hone|ad|od)/.test(navigator.platform ?? navigator.userAgent)

export const useVisualViewportHeight = (): number | null => {
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!isIOS()) return
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const update = () => {
      // Snap back to null (h-dvh) once the keyboard is closed — heals the
      // stuck-short state on devices that miss the final resize event.
      const atFullHeight = Math.abs(vv.height - window.innerHeight) < 10
      setHeight(atFullHeight ? null : vv.height)
    }
    update()
    vv.addEventListener('resize', update)
    return () => {
      vv.removeEventListener('resize', update)
    }
  }, [])

  return height
}
