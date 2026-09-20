import { useEffect, useRef } from 'react'

import type { RemoteDeviceView } from '../api.js'
import { useI18n } from '../i18n.js'
import { useNotifications } from './NotificationProvider.js'

interface RemoteSessionNotificationsProps {
  /** The remote device-session list the Remote settings panel already loads
   *  (listRemoteDevices). Polled/refreshed by the parent; this component only
   *  diffs successive snapshots. */
  devices: RemoteDeviceView[]
  /** Remote access feature flag. While off no diff runs and the snapshot stays
   *  empty, so flipping it on later never replays a backlog of "new" devices. */
  enabled: boolean
}

/**
 * Headless desktop-only alert: surfaces a notification when a remote device
 * appears that was NOT active in the prior snapshot (a newly paired / freshly
 * re-added device established a session). Mirrors WorkspaceNotifications'
 * prior-vs-current diff so it rides the SAME settings-aware notify() channel
 * (toast + sound + desktop permission). MUST mount in the desktop shell only —
 * the alert is for the person at the keyboard, and a phone's TunnelTransport
 * cannot observe other devices' sessions anyway.
 *
 * Caveat (documented, not a security control): the desktop notification only
 * fires when this tab is open AND settings.desktop is granted. The reliable
 * closed-laptop channel remains webhook -> ntfy/Bark per the Parity Matrix.
 */
export const RemoteSessionNotifications = ({
  devices,
  enabled,
}: RemoteSessionNotificationsProps) => {
  const { notify } = useNotifications()
  const { t } = useI18n()
  // Set of active (non-revoked) device ids from the previous render. null means
  // "not seeded yet" so the very first snapshot never fires (an already-paired
  // device on load is not a new session).
  const previous = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!enabled) {
      // Drop the baseline while off so re-enabling re-seeds instead of diffing
      // against a pre-disable snapshot and replaying every device as "new".
      previous.current = null
      return
    }

    // A revoked device is not an active session; treat it as absent so a
    // later re-pair (same id, now active) counts as a fresh connection.
    const active = new Map(devices.filter((d) => !d.revoked).map((d) => [d.deviceId, d]))
    const prior = previous.current
    previous.current = new Set(active.keys())

    if (!prior) return

    for (const [deviceId, view] of active) {
      if (prior.has(deviceId)) continue
      notify({
        brief: t('notifications.remoteSession.brief', { name: view.name }),
        detail: t('notifications.remoteSession.detail', { name: view.name }),
        // ToastKind has no 'info'; a new session is a neutral/positive event, so
        // 'success' (same as workerStarted) is the closest existing kind.
        kind: 'success',
        title: t('notifications.remoteSession.title'),
      })
    }
  }, [devices, enabled, notify, t])

  return null
}
