/**
 * Honest WebGL detection so the terminal picks a renderer it can actually use.
 * Some mobile browsers expose no stable WebGL context; loading @xterm/addon-webgl
 * there white-screens the terminal. We probe a throwaway canvas before loading
 * the addon and fall back to xterm's default canvas renderer when WebGL is
 * absent. The canvas factory is injectable so the check is testable in jsdom.
 */

export const detectWebglSupport = (
  createCanvas: () => HTMLCanvasElement | null = () =>
    typeof document !== 'undefined' ? document.createElement('canvas') : null
): boolean => {
  const canvas = createCanvas()
  if (!canvas || typeof canvas.getContext !== 'function') return false
  try {
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}
