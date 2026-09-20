import { useSyncExternalStore } from 'react'

// Phone "focus mode": collapse the topbar + bottom nav so the terminal owns
// the whole screen. Module store (not prop drilling) because the toggle lives
// in the Team page's segmented strip (WorkspaceDetail) while the chrome it
// hides belongs to MobileShell — same pattern as connection-status-store.

let focused = false
const listeners = new Set<() => void>()

export const getMobileFocusMode = (): boolean => focused

export const setMobileFocusMode = (value: boolean): void => {
  if (focused === value) return
  focused = value
  for (const listener of listeners) listener()
}

export const toggleMobileFocusMode = (): void => {
  setMobileFocusMode(!focused)
}

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export const useMobileFocusMode = (): boolean =>
  useSyncExternalStore(subscribe, getMobileFocusMode, () => false)
