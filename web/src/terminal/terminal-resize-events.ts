export const TERMINAL_VISIBLE_RESIZE_EVENT = 'hive:terminal-visible-resize'

export type TerminalVisibleResizeEvent = CustomEvent<{ runId: string }>

export const createTerminalVisibleResizeEvent = (runId: string): TerminalVisibleResizeEvent =>
  new CustomEvent(TERMINAL_VISIBLE_RESIZE_EVENT, { detail: { runId } })
