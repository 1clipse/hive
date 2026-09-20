import { Check, Copy, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  getDiagnosticsSupportBundle,
  getRetentionSignals,
  type RemoteConnectionStatus,
  type RetentionSignals,
} from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { copyPendingTextToClipboard } from '../lib/clipboard.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Confirm } from '../ui/Confirm.js'
import { Switch } from '../ui/Switch.js'
import { useToast } from '../ui/useToast.js'
import { AddDeviceFlow } from './AddDeviceFlow.js'
import { RemoteAuditView } from './RemoteAuditView.js'
import { RemoteDeviceList } from './RemoteDeviceList.js'
import { useRemoteFeature } from './useRemoteFeature.js'

// The status dot color + (for the transient/terminal states) its label, keyed off the full tunnel
// connection state. online = green, connecting/reconnecting = amber (the states a flaky link lingers
// in), revoked = red, disabled/loggedOut = grey (the login text already explains those).
const CONNECTION_DOT: Record<RemoteConnectionStatus, string> = {
  online: 'var(--status-green)',
  connecting: 'var(--status-amber, #d29922)',
  reconnecting: 'var(--status-amber, #d29922)',
  revoked: 'var(--status-red, #f85149)',
  loggedOut: 'var(--text-ter)',
  disabled: 'var(--text-ter)',
}
const CONNECTION_LABEL: Partial<Record<RemoteConnectionStatus, TranslationKey>> = {
  connecting: 'remote.status.connecting',
  reconnecting: 'remote.status.reconnecting',
  revoked: 'remote.status.revoked',
}

/**
 * Settings popover block for remote access. The enable switch is off by
 * default; while off, nothing below it renders (no device list, no Add device)
 * — the UI half of invariant 6. The confirm dialog lives at the app top level
 * (not here), so a phone can finish pairing while this popover is closed.
 */
export const RemoteAccessSection = () => {
  const { t } = useI18n()
  const toast = useToast()
  // Adding a new device mints a fresh pairing — that's the desktop trust root
  // (Authority Model). On a phone (over the tunnel) the daemon-only mint
  // endpoint 403s, so the affordance would be a guaranteed-error button; worse,
  // it would surface a trust-root surface remotely. Hide it on mobile while the
  // equal-authority device list + revoke stay fully usable.
  const isMobile = useIsMobile()
  const { status, loading, setEnabled, pending } = useRemoteFeature()
  const connectionDot = CONNECTION_DOT[status.connection]
  const connectionLabelKey = CONNECTION_LABEL[status.connection]
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  // J9: on mobile, turning OFF requires a confirmation (the phone severs its own tunnel and can't
  // re-enable remotely — per trust-root rule). ON transition is immediate on both platforms.
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false)
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const [retention, setRetention] = useState<RetentionSignals | null>(null)
  const [retentionLoadFailed, setRetentionLoadFailed] = useState(false)
  const diagnosticsCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bump after a pairing ceremony ends (pending goes non-null -> null) so the
  // device list re-fetches and a newly-confirmed device shows immediately.
  const [deviceReloadKey, setDeviceReloadKey] = useState(0)
  const hadPending = useRef(false)
  useEffect(() => {
    if (pending) {
      hadPending.current = true
    } else if (hadPending.current) {
      hadPending.current = false
      setDeviceReloadKey((k) => k + 1)
    }
  }, [pending])

  useEffect(
    () => () => {
      if (diagnosticsCopiedTimer.current) clearTimeout(diagnosticsCopiedTimer.current)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    void getRetentionSignals()
      .then((signals) => {
        if (!cancelled) {
          setRetention(signals)
          setRetentionLoadFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setRetentionLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const doSetEnabled = async (checked: boolean) => {
    setSaveError(false)
    setSaving(true)
    try {
      await setEnabled(checked)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (checked: boolean) => {
    // J9: gate the OFF transition on mobile behind a confirm dialog.
    if (!checked && isMobile) {
      setConfirmDisable(true)
      return
    }
    void doSetEnabled(checked)
  }

  const copyDiagnostics = async () => {
    if (copyingDiagnostics) return
    setCopyingDiagnostics(true)
    try {
      // Kick off the fetch and hand the pending text to the clipboard helper
      // before any await: Safari only honors clipboard writes issued inside
      // the click gesture's activation window.
      const pendingText = getDiagnosticsSupportBundle().then((bundle) =>
        JSON.stringify(bundle, null, 2)
      )
      await copyPendingTextToClipboard(pendingText)
      setDiagnosticsCopied(true)
      if (diagnosticsCopiedTimer.current) clearTimeout(diagnosticsCopiedTimer.current)
      diagnosticsCopiedTimer.current = setTimeout(() => {
        setDiagnosticsCopied(false)
        diagnosticsCopiedTimer.current = null
      }, 1200)
      toast.show({ kind: 'success', message: t('remote.diagnostics.copied') })
    } catch {
      toast.show({ kind: 'error', message: t('remote.diagnostics.copyFailed') })
    } finally {
      setCopyingDiagnostics(false)
    }
  }

  const retentionCurrentStreakDays = retention?.current_streak_days ?? 0
  const retentionDaysActiveTotal = retention?.days_active_total ?? 0
  const retentionSendsTotal = retention?.totals?.send ?? 0
  const retentionReportsTotal = retention?.totals?.report ?? 0

  return (
    <div className="settings-section" data-testid="remote-access-section">
      <div className="settings-section__heading">
        <Smartphone size={12} aria-hidden />
        <span>{t('remote.section')}</span>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click handler on row for mouse users; Switch button provides keyboard access */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click handler on row for mouse users; Switch button provides keyboard access */}
      <div
        className="settings-toggle-row"
        onClick={() => {
          if (!loading && !saving) handleToggle(!status.enabled)
        }}
      >
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-medium text-pri">{t('remote.enable.label')}</span>
          <span className="mt-0.5 block text-xs text-ter leading-relaxed">
            {t('remote.enable.description')}
          </span>
        </span>
        <div className="mt-0.5 shrink-0">
          <Switch
            checked={status.enabled}
            disabled={loading || saving}
            onChange={handleToggle}
            data-testid="settings-toggle-remote"
            aria-label={t('remote.enable.label')}
          />
        </div>
      </div>
      {saveError ? (
        <div className="mt-1 ml-2 text-xs" style={{ color: 'var(--text-error)' }} role="alert">
          {t('settings.saveError')}
        </div>
      ) : null}
      <button
        type="button"
        data-testid="remote-copy-diagnostics"
        onClick={copyDiagnostics}
        disabled={copyingDiagnostics}
        className="icon-btn mt-2 w-full justify-center pointer-coarse:min-h-11"
      >
        {diagnosticsCopied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        <span>
          {copyingDiagnostics
            ? t('remote.diagnostics.copying')
            : diagnosticsCopied
              ? t('remote.diagnostics.copied')
              : t('remote.diagnostics.copy')}
        </span>
      </button>
      <div
        className="mt-2 rounded border px-3 py-2 text-xs"
        data-testid="retention-diagnostics-panel"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium text-sec">{t('remote.retention.title')}</span>
          <span className="text-ter">{t('remote.retention.localOnly')}</span>
        </div>
        {retentionLoadFailed ? (
          <p className="text-ter">{t('remote.retention.loadFailed')}</p>
        ) : retention ? (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-lg font-semibold text-pri">{retentionCurrentStreakDays}</div>
              <div className="text-ter">{t('remote.retention.streak')}</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-pri">{retentionDaysActiveTotal}</div>
              <div className="text-ter">{t('remote.retention.activeDays')}</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-pri">{retentionSendsTotal}</div>
              <div className="text-ter">{t('remote.retention.sends')}</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-pri">{retentionReportsTotal}</div>
              <div className="text-ter">{t('remote.retention.reports')}</div>
            </div>
          </div>
        ) : (
          <p className="text-ter">{t('common.loading')}</p>
        )}
      </div>
      {status.enabled ? (
        <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
          <div
            className="flex items-center gap-2 rounded px-2 py-1.5 text-xs"
            data-testid="remote-login-status"
          >
            <span
              aria-hidden
              data-connection={status.connection}
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: connectionDot }}
            />
            <span className="min-w-0 text-sec">
              {connectionLabelKey
                ? t(connectionLabelKey)
                : status.loggedIn
                  ? t('remote.status.linked', { gateway: status.gatewayUrl ?? '' })
                  : t('remote.status.notLinked')}
            </span>
          </div>
          {status.loggedIn && !isMobile ? <AddDeviceFlow /> : null}
          <RemoteDeviceList reloadKey={deviceReloadKey} />
          <RemoteAuditView />
        </div>
      ) : null}
      {/* J9: mobile-only confirm for turning off remote access */}
      <Confirm
        open={confirmDisable}
        onOpenChange={(open) => {
          if (!open) setConfirmDisable(false)
        }}
        title={t('remote.disable.confirmTitle')}
        description={t('remote.disable.confirmBody')}
        confirmLabel={t('common.stop')}
        confirmKind="danger"
        onConfirm={() => {
          void doSetEnabled(false)
        }}
      />
    </div>
  )
}
