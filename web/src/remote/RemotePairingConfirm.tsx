import * as Dialog from '@radix-ui/react-dialog'
import { ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { confirmPairing as apiConfirmPairing, rejectPairing as apiRejectPairing } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { useToast } from '../ui/useToast.js'
import { useRemoteFeature } from './useRemoteFeature.js'

/**
 * The desktop trust-root gate (Authority Model). Mounts at the top level so it
 * can pop even when the Settings popover is closed — a phone may finish its
 * handshake any time. Renders ONLY when a pairing is awaiting confirm.
 *
 * Confirm -> POST /pairings/:id/confirm (the one persisting call). Escape /
 * overlay click / expiry all map to REJECT, never a neutral dismiss that would
 * leave a usable pairing staged. No <form> so there is no Enter-submits-Confirm
 * footgun.
 */
export const RemotePairingConfirm = () => {
  const { t } = useI18n()
  const toast = useToast()
  // Defense-in-depth for the trust root: approving a new device is a
  // desktop-only act. The transport already keeps `pending` null over the
  // tunnel (the daemon-only pending endpoint 403s), but we also refuse to
  // surface the approve dialog on the mobile layout so a phone can never
  // confirm a device even if a pending pairing somehow reaches it.
  const isMobile = useIsMobile()
  const { pending, refresh } = useRemoteFeature()
  const [busy, setBusy] = useState(false)
  // Guard so an expiry tick + a manual click can't both fire the closing path.
  const closingRef = useRef(false)

  const displayName = pending?.deviceName ?? ''
  const pairingId = pending?.pairingId ?? null
  const expiresAt = pending?.expiresAt ?? null

  // A fresh pairing re-arms the closing guard so a previous ceremony's close
  // can't suppress this one.
  useEffect(() => {
    if (pairingId !== null) closingRef.current = false
  }, [pairingId])

  const handleConfirm = useCallback(async () => {
    if (!pairingId || busy || closingRef.current) return
    closingRef.current = true
    setBusy(true)
    try {
      await apiConfirmPairing(pairingId)
      toast.show({ kind: 'success', message: t('remote.confirm.paired', { name: displayName }) })
    } catch {
      closingRef.current = false
      toast.show({ kind: 'error', message: t('remote.confirm.failed') })
    } finally {
      setBusy(false)
      await refresh()
    }
  }, [pairingId, busy, displayName, refresh, t, toast])

  const handleReject = useCallback(
    async (kind: 'rejected' | 'expired') => {
      if (!pairingId || closingRef.current) return
      closingRef.current = true
      try {
        await apiRejectPairing(pairingId)
      } catch {
        // Best-effort: even if the reject call fails, refresh() reconciles UI to
        // the server's truth; the device is never usable without an explicit
        // confirm regardless.
      }
      toast.show({
        kind: kind === 'expired' ? 'warning' : 'success',
        message: kind === 'expired' ? t('remote.confirm.expired') : t('remote.confirm.rejected'),
      })
      setBusy(false)
      await refresh()
    },
    [pairingId, refresh, t, toast]
  )

  // Auto-reject when the pairing TTL elapses while the dialog is open. The
  // server already drops it; we mirror that and tell the user.
  useEffect(() => {
    if (expiresAt === null) return
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      void handleReject('expired')
      return
    }
    const id = window.setTimeout(() => {
      void handleReject('expired')
    }, remaining)
    return () => window.clearTimeout(id)
  }, [expiresAt, handleReject])

  if (!pending || isMobile) return null

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        // Any close gesture (Escape, overlay click) is a rejection, never a
        // neutral dismiss — a staged pairing must not survive a casual close.
        if (!open) void handleReject('rejected')
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="remote-pairing-confirm-overlay"
          className="app-overlay fixed inset-0 z-[80]"
        />
        <div className="pointer-events-none fixed inset-0 z-[90] grid place-items-center p-4">
          <Dialog.Content
            data-testid="remote-pairing-confirm"
            className="dialog-scale-pop elev-2 pointer-events-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="flex items-start gap-3">
              <div
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                  color: 'var(--accent)',
                  border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                }}
              >
                <ShieldCheck size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('remote.confirm.title')}
                </Dialog.Title>
                <Dialog.Description className="mt-1.5 text-sm text-sec">
                  {t('remote.confirm.description', { name: displayName })}
                </Dialog.Description>
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-ter">
                {t('remote.confirm.sasLabel')}
              </div>
              <div
                data-testid="remote-pairing-sas"
                className="rounded border bg-2 py-3 text-center font-mono text-3xl tracking-[0.4em] text-pri"
                style={{ borderColor: 'var(--border)' }}
              >
                {pending.sas}
              </div>
              <p className="mt-2 text-xs text-ter">{t('remote.confirm.warning')}</p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="remote-pairing-reject"
                onClick={() => void handleReject('rejected')}
                disabled={busy}
                className="icon-btn"
              >
                {t('remote.confirm.reject')}
              </button>
              <button
                type="button"
                data-testid="remote-pairing-confirm-action"
                onClick={() => void handleConfirm()}
                disabled={busy}
                className="icon-btn icon-btn--primary"
              >
                {busy ? t('remote.confirm.confirming') : t('remote.confirm.confirm')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
