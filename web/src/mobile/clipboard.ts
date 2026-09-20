/**
 * The phone's clipboard is a SEPARATE channel from the remote terminal's stdin (Parity row ⚠️
 * "clipboard distinct"). These two helpers touch only `navigator.clipboard` — neither writes to a
 * terminal. Bridging clipboard text into the PTY must remain an explicit user action that routes
 * through bracketed-paste framing, never a side effect of copy/read.
 */

/** Copy a selection (e.g. terminal output) to the phone's clipboard. Does not touch the terminal. */
export const copySelectionToPhoneClipboard = (text: string): Promise<void> =>
  navigator.clipboard.writeText(text)

/**
 * Read the phone's clipboard for the paste-with-confirm flow. The caller still has to route the
 * result through the confirm dialog + bracketed-paste framing before any of it reaches stdin.
 */
export const readPhoneClipboardForPaste = (): Promise<string> => navigator.clipboard.readText()
