import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import {
  setRemoteEnabled as apiSetRemoteEnabled,
  getPendingPairing,
  getRemoteStatus,
  type PendingPairing,
  type RemoteStatus,
} from '../api.js'
import { useIsMobile } from '../mobile/layout-mode.js'

/** How often we poll for a pending pairing while remote access is on. The
 *  desktop confirm dialog needs to pop the moment a phone finishes its
 *  handshake; a 2s poll on 127.0.0.1 is cheap and (with fake timers) testable.
 *  M5 owns the real transport, so a WS push can replace this later. */
const PENDING_POLL_MS = 2000

const SAFE_DISABLED: RemoteStatus = {
  enabled: false,
  loggedIn: false,
  gatewayUrl: null,
  connected: false,
  connection: 'disabled',
}

interface RemoteFeatureValue {
  status: RemoteStatus
  /** True until the initial GET /status settles. */
  loading: boolean
  setEnabled: (enabled: boolean) => Promise<void>
  /** The in-flight pairing awaiting desktop confirm, or null. Forced null while
   *  remote access is off / logged out (no poll is armed then). */
  pending: PendingPairing | null
  /** Re-pull status + pending (called after confirm/reject resolve). */
  refresh: () => Promise<void>
}

const RemoteFeatureContext = createContext<RemoteFeatureValue>({
  status: SAFE_DISABLED,
  loading: true,
  setEnabled: async () => {},
  pending: null,
  refresh: async () => {},
})

export const RemoteFeatureProvider = ({ children }: { children: ReactNode }) => {
  const isMobile = useIsMobile()
  const [status, setStatus] = useState<RemoteStatus>(SAFE_DISABLED)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PendingPairing | null>(null)

  useEffect(() => {
    let cancelled = false
    void getRemoteStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => {
        // A failed load is treated as safe-disabled — the off default.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = useCallback(async (next: boolean) => {
    const result = await apiSetRemoteEnabled(next)
    setStatus(result)
    // Turning remote off must drop any pending pairing immediately — the poll
    // teardown below also handles it, but this avoids a stale dialog frame.
    if (!result.enabled) setPending(null)
  }, [])

  const refresh = useCallback(async () => {
    const next = await getRemoteStatus().catch(() => SAFE_DISABLED)
    setStatus(next)
    if (next.enabled && next.loggedIn && !isMobile) {
      setPending(await getPendingPairing().catch(() => null))
    } else {
      setPending(null)
    }
  }, [isMobile])

  // Only poll while remote access is on AND linked. When off/logged-out no
  // interval is armed and pending is forced null — invariant 6 at the UI layer.
  // Mobile is equal-authority for normal /api and /ws routes, but new-device
  // approval is the desktop trust root; do not even poll the desktop-only
  // pending endpoint from the phone.
  const pollArmed = status.enabled && status.loggedIn && !isMobile
  useEffect(() => {
    if (!pollArmed) {
      setPending(null)
      return
    }
    let cancelled = false
    const tick = () => {
      // Re-pull status too (not just pending): the connection state (connecting/reconnecting/online)
      // drifts while the link flaps, and the desktop dot must reflect it — a one-shot initial fetch
      // left the dot showing a stale state.
      void getRemoteStatus()
        .then((next) => {
          if (!cancelled) setStatus(next)
        })
        .catch(() => {
          // Swallow — keep the last known status rather than flipping to disabled on a transient blip.
        })
      void getPendingPairing()
        .then((next) => {
          if (!cancelled) setPending(next)
        })
        .catch(() => {
          // Swallow poll failures — treat as "no pending" rather than surfacing.
        })
    }
    tick()
    const id = window.setInterval(tick, PENDING_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [pollArmed])

  return (
    <RemoteFeatureContext.Provider value={{ status, loading, setEnabled, pending, refresh }}>
      {children}
    </RemoteFeatureContext.Provider>
  )
}

export const useRemoteFeature = (): RemoteFeatureValue => useContext(RemoteFeatureContext)
