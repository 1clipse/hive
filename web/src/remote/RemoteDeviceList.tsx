import { useCallback, useEffect, useState } from 'react'

import { listRemoteDevices, type RemoteDeviceView, revokeRemoteDevice } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { useToast } from '../ui/useToast.js'

/** Coarse relative time for the last-active column — returns a short bare unit
 *  string (no trailing "ago") so callers can embed it in locale-aware templates. */
const relativeAgo = (ms: number): string => {
  const delta = Math.max(0, Date.now() - ms)
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** Reload trigger: parent bumps {reloadKey} after a pairing confirm so a newly
 *  paired device shows without a full remount. */
export const RemoteDeviceList = ({ reloadKey = 0 }: { reloadKey?: number }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [devices, setDevices] = useState<RemoteDeviceView[] | null>(null)
  const [error, setError] = useState(false)
  const [pendingRevoke, setPendingRevoke] = useState<RemoteDeviceView | null>(null)

  const load = useCallback(async () => {
    setError(false)
    try {
      const next = await listRemoteDevices()
      setDevices(next)
    } catch {
      setError(true)
    }
  }, [])

  // Re-fetch on mount and whenever the parent bumps reloadKey (a pairing just
  // completed). reloadKey is read here purely as the re-run trigger.
  useEffect(() => {
    void reloadKey
    void load()
  }, [load, reloadKey])

  const doRevoke = async (device: RemoteDeviceView) => {
    try {
      await revokeRemoteDevice(device.deviceId)
      toast.show({ kind: 'success', message: t('remote.devices.revoked', { name: device.name }) })
      await load()
    } catch {
      toast.show({ kind: 'error', message: t('remote.devices.revokeFailed') })
    }
  }

  const active = (devices ?? []).filter((d) => !d.revoked)

  return (
    <div className="p-1.5" data-testid="remote-device-list">
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-ter">
        {t('remote.devices.heading')}
      </div>
      {error ? (
        <div className="text-xs" style={{ color: 'var(--text-error)' }} role="alert">
          {t('remote.devices.loadFailed')}
        </div>
      ) : active.length === 0 ? (
        <div className="text-xs text-ter">{t('remote.devices.empty')}</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {active.map((device) => (
            <li
              key={device.deviceId}
              className="flex items-center justify-between gap-2 rounded p-1.5 hover:bg-3"
              data-testid={`remote-device-${device.deviceId}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-pri">{device.name}</span>
                <span className="block text-xs text-ter">
                  {device.lastActive === null
                    ? t('remote.devices.neverActive')
                    : relativeAgo(device.lastActive) === '<1m'
                      ? t('remote.devices.activeNow')
                      : t('remote.devices.lastActive', { ago: relativeAgo(device.lastActive) })}
                </span>
              </span>
              <button
                type="button"
                data-testid={`remote-device-revoke-${device.deviceId}`}
                aria-label={t('remote.devices.revokeAria', { name: device.name })}
                onClick={() => setPendingRevoke(device)}
                className="icon-btn icon-btn--danger shrink-0"
              >
                {t('remote.devices.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Confirm
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null)
        }}
        title={t('remote.devices.revokeTitle')}
        description={
          pendingRevoke ? t('remote.devices.revokeConfirm', { name: pendingRevoke.name }) : ''
        }
        confirmLabel={t('remote.devices.revoke')}
        confirmKind="danger"
        onConfirm={() => {
          if (pendingRevoke) void doRevoke(pendingRevoke)
        }}
      />
    </div>
  )
}
