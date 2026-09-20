// Minimal module-level store for the tunnel connection status, consumed by the mobile topbar banner.
// On desktop (direct transport) this is never written; the snapshot stays null and the banner is absent.

import type { ConnectionStatus } from './api-transport.js'

let current: ConnectionStatus | null = null
const listeners = new Set<() => void>()

export const setConnectionStatus = (status: ConnectionStatus | null): void => {
  current = status
  for (const cb of listeners) cb()
}

// useSyncExternalStore-compatible pair for React components.
export const subscribeConnectionStatus = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const getConnectionStatus = (): ConnectionStatus | null => current
