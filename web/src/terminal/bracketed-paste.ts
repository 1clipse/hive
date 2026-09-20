/**
 * Bracketed-paste framing for the mobile paste-with-confirm flow. When the
 * remote PTY has bracketed paste enabled (the xterm default), a multi-line paste
 * must be wrapped so the agent's editor treats it as one literal block instead
 * of replaying each newline as Enter. The desktop terminal gets this for free
 * via xterm's own paste path; the mobile composer pastes through sendInput, so
 * we frame it here.
 */

export const BRACKETED_PASTE_START = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

interface BracketedPasteTerminal {
  modes?: {
    bracketedPasteMode?: boolean
  }
}

export const wrapBracketedPaste = (text: string, terminal?: BracketedPasteTerminal): string => {
  // An embedded end-marker would let the payload break out of the bracket, so
  // strip every occurrence before framing.
  const safe = text.split(BRACKETED_PASTE_END).join('')
  // Only skip framing when we positively know the mode is off. Unknown (no
  // terminal / no modes) defaults to wrap, matching xterm's default-on state.
  if (terminal?.modes?.bracketedPasteMode === false) return safe
  return `${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}`
}
