/**
 * Detect whether the document is running as an installed PWA (Chromium /
 * Edge / Firefox standalone window, or iOS Safari home-screen install).
 *
 * Why this matters: several of Hive's keyboard shortcuts bind keystrokes
 * that browsers reserve at the OS level (`Ctrl+Shift+N` opens an
 * incognito window, `Ctrl+1..9` switches tabs). In a regular tab those
 * shortcuts cannot be reliably `preventDefault`'d — the browser handles
 * them before the page sees the event. Inside an installed PWA window
 * the browser drops those bindings, so the page can claim them.
 *
 * The two checks cover the platforms separately:
 *   - `matchMedia('(display-mode: standalone)')` is the spec-defined
 *     query and is supported by Chromium, Edge, and Firefox installs.
 *   - `navigator.standalone` is the iOS Safari home-screen idiom that
 *     never picked up the standard match-media query.
 *
 * Both arguments are injectable so the unit test can exercise every
 * combination without touching real `window`.
 */
export const isStandalonePwa = (
  matchMedia: ((query: string) => MediaQueryList) | undefined = typeof window !== 'undefined'
    ? window.matchMedia.bind(window)
    : undefined,
  iosStandalone: boolean | undefined = typeof navigator !== 'undefined'
    ? (navigator as { standalone?: boolean }).standalone
    : undefined
): boolean => {
  if (matchMedia?.('(display-mode: standalone)').matches) return true
  return iosStandalone === true
}
