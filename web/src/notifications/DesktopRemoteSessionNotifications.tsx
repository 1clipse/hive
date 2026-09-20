import { useRemoteDevicePoll } from '../remote/useRemoteDevicePoll.js'
import { useRemoteFeature } from '../remote/useRemoteFeature.js'
import { RemoteSessionNotifications } from './RemoteSessionNotifications.js'

/**
 * Desktop wiring for the remote-session alert. Polls the device list while
 * remote access is enabled + linked and feeds it to the headless diff component.
 * Mounted in the desktop shell only (never MobileShell) — the alert is for the
 * person at the keyboard, and the phone cannot observe other devices' sessions.
 */
export const DesktopRemoteSessionNotifications = () => {
  const { status } = useRemoteFeature()
  const armed = status.enabled && status.loggedIn
  const devices = useRemoteDevicePoll(armed)
  return <RemoteSessionNotifications devices={devices} enabled={armed} />
}
