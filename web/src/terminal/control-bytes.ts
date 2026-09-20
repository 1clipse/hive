/**
 * Named terminal control keys mapped to the raw byte sequences a CLI agent's
 * readline / TUI expects. Mobile and desktop controls only ever send these bytes
 * — identical to what a physical keyboard would emit. Overlapping editing keys
 * import from SHORTCUT_BYTES so command surfaces and the desktop shortcut
 * resolver share one source of truth, and arrows reuse arrowSequence so they can
 * never diverge from the wheel fallback.
 */

import { SHORTCUT_BYTES } from './shortcuts.js'
import { arrowSequence } from './wheelFallback.js'

export type TerminalKeyName =
  | 'esc'
  | 'tab'
  | 'enter'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'home'
  | 'end'
  | 'ctrlC'
  | 'ctrlD'
  | 'ctrlZ'
  | 'ctrlL'
  | 'ctrlR'
  | 'ctrlU'
  | 'ctrlA'
  | 'ctrlE'
  | 'ctrlW'

export interface ControlByteContext {
  applicationCursorKeys?: boolean
}

export const resolveControlBytes = (key: TerminalKeyName, ctx: ControlByteContext = {}): string => {
  switch (key) {
    case 'esc':
      return '\x1b'
    case 'tab':
      return '\t'
    case 'enter':
      // CR, not LF: xterm runs with convertEol:false so the PTY sees \r.
      return '\r'
    case 'arrowUp':
      return arrowSequence(ctx.applicationCursorKeys, 'up')
    case 'arrowDown':
      return arrowSequence(ctx.applicationCursorKeys, 'down')
    case 'arrowRight':
      return ctx.applicationCursorKeys ? '\x1bOC' : '\x1b[C'
    case 'arrowLeft':
      return ctx.applicationCursorKeys ? '\x1bOD' : '\x1b[D'
    case 'home':
      return '\x1b[H'
    case 'end':
      return '\x1b[F'
    case 'ctrlC':
      return '\x03'
    case 'ctrlD':
      return '\x04'
    case 'ctrlZ':
      return '\x1a'
    case 'ctrlL':
      return '\x0c'
    case 'ctrlR':
      return '\x12'
    case 'ctrlU':
      return SHORTCUT_BYTES.killToLineStart
    case 'ctrlA':
      return SHORTCUT_BYTES.lineStart
    case 'ctrlE':
      return SHORTCUT_BYTES.lineEnd
    case 'ctrlW':
      // readline kill-word-back; not in SHORTCUT_BYTES (desktop uses Alt+Bksp).
      return '\x17'
  }
}
