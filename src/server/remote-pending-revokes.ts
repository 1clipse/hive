import { REMOTE_GATEWAY_URL_KEY, REMOTE_PENDING_REVOKES_KEY } from './remote-config-keys.js'

// CLI and daemon share a durable queue. Each read-modify-write must run in a
// transaction on the SAME SQLite connection as these accessors. A synchronous
// JavaScript callback alone does not protect against another process's writes.

export interface PendingRevokesStore {
  getAppState(key: string): { value: string | null } | undefined
  setAppState(key: string, value: string | null): void
  transaction<T>(mutation: () => T): T
}

export interface PendingRevoke {
  deviceId: string
  gatewayUrl: string | null
}

export const getPendingRevokeGateway = (store: PendingRevokesStore): string | null =>
  store.getAppState(REMOTE_GATEWAY_URL_KEY)?.value?.replace(/\/+$/, '') || null

export const readPendingRevokes = (store: PendingRevokesStore): PendingRevoke[] => {
  const raw = store.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value
  if (raw == null) return []
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new TypeError('Invalid persisted remote revocation queue')
  }
  return parsed.map((entry: unknown) => {
    // Old unscoped entries remain pending: guessing their gateway after a
    // login change could silently acknowledge another gateway's device.
    if (typeof entry === 'string' && entry.length > 0) {
      return { deviceId: entry, gatewayUrl: null }
    }
    if (
      entry &&
      typeof entry === 'object' &&
      'deviceId' in entry &&
      typeof entry.deviceId === 'string' &&
      entry.deviceId.length > 0 &&
      'gatewayUrl' in entry &&
      (entry.gatewayUrl === null ||
        (typeof entry.gatewayUrl === 'string' && entry.gatewayUrl.length > 0))
    ) {
      return { deviceId: entry.deviceId, gatewayUrl: entry.gatewayUrl }
    }
    throw new TypeError('Invalid persisted remote revocation queue')
  })
}

const writePendingRevokes = (store: PendingRevokesStore, entries: PendingRevoke[]): void => {
  store.setAppState(REMOTE_PENDING_REVOKES_KEY, entries.length > 0 ? JSON.stringify(entries) : null)
}

/** Fresh-read add. Throws on real store failures so the caller can surface them. */
export const addPendingRevoke = (store: PendingRevokesStore, deviceId: string): PendingRevoke =>
  store.transaction(() => {
    const pending = readPendingRevokes(store)
    const entry = { deviceId, gatewayUrl: getPendingRevokeGateway(store) }
    if (
      !pending.some((item) => item.deviceId === deviceId && item.gatewayUrl === entry.gatewayUrl)
    ) {
      writePendingRevokes(store, [...pending, entry])
    }
    return entry
  })

/** Ack only this device on this gateway, preserving other origins and fresh writes. */
export const removePendingRevoke = (store: PendingRevokesStore, entry: PendingRevoke): void => {
  store.transaction(() => {
    const pending = readPendingRevokes(store)
    writePendingRevokes(
      store,
      pending.filter(
        (item) => item.deviceId !== entry.deviceId || item.gatewayUrl !== entry.gatewayUrl
      )
    )
  })
}
