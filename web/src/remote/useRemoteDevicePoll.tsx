import { useEffect, useState } from 'react'

import { listRemoteDevices, type RemoteDeviceView } from '../api.js'

/** Poll cadence for the desktop remote-session watcher. The settings panel
 *  refreshes its device list on demand; this background poll exists so a new
 *  session surfaces a notification even when that popover is closed. A few-second
 *  loopback poll is cheap and matches the pending-pairing poll's cadence. */
const DEVICE_POLL_MS = 4000

/**
 * Background poll of the remote device list, gated on `armed` (remote enabled +
 * logged in). Returns the latest snapshot, starting empty until the first load.
 * Desktop-only by intent — the caller mounts it outside MobileShell.
 */
export const useRemoteDevicePoll = (armed: boolean): RemoteDeviceView[] => {
  const [devices, setDevices] = useState<RemoteDeviceView[]>([])

  useEffect(() => {
    if (!armed) {
      // Clear so a re-arm re-seeds from a fresh load rather than diffing against
      // a stale pre-disable snapshot.
      setDevices([])
      return
    }
    let cancelled = false
    const tick = () => {
      void listRemoteDevices()
        .then((next) => {
          if (!cancelled) setDevices(next)
        })
        .catch(() => {
          // Swallow poll failures; a transient loopback error should not clear
          // the snapshot (that would replay every device as "new" on recovery).
        })
    }
    tick()
    const id = window.setInterval(tick, DEVICE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [armed])

  return devices
}
