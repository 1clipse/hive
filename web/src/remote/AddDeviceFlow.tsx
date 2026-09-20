import { Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'

import { startPairing } from '../api.js'
import { useI18n } from '../i18n.js'

interface ActiveTicket {
  pairingId: string
  code: string
  expiresAt: number
}

/** Seconds left until {expiresAt}, never negative. Recomputed on a 1s tick. */
const secondsLeft = (expiresAt: number): number =>
  Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))

/**
 * "Add device" -> POST /pairings -> inline pairing-code panel with a live countdown and a Cancel
 * that just collapses the panel (the server TTL is the real expiry).
 */
export const AddDeviceFlow = () => {
  const { t } = useI18n()
  const [ticket, setTicket] = useState<ActiveTicket | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Drive the countdown only while a ticket is shown.
  useEffect(() => {
    if (!ticket) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [ticket])

  const start = async () => {
    setError(false)
    setStarting(true)
    try {
      const next = await startPairing()
      setTicket(next)
      setNow(Date.now())
    } catch {
      setError(true)
    } finally {
      setStarting(false)
    }
  }

  if (!ticket) {
    return (
      <div className="p-1.5">
        <button
          type="button"
          data-testid="settings-remote-add-device"
          onClick={() => void start()}
          disabled={starting}
          className="icon-btn icon-btn--primary flex items-center gap-1.5"
        >
          <Smartphone size={14} aria-hidden />
          {t('remote.addDevice')}
        </button>
        {error ? (
          <div className="mt-1 text-xs" style={{ color: 'var(--text-error)' }} role="alert">
            {t('remote.qr.startFailed')}
          </div>
        ) : null}
      </div>
    )
  }

  const remaining = secondsLeft(ticket.expiresAt)
  const expired = remaining <= 0 || now >= ticket.expiresAt

  return (
    <div className="p-1.5" data-testid="remote-qr-panel">
      <div className="text-sm font-medium text-pri">{t('remote.qr.title')}</div>
      <p className="mt-0.5 mb-2 text-xs text-ter">{t('remote.qr.instructions')}</p>
      <div className="flex flex-col items-center gap-2">
        {expired ? (
          <div
            className="text-xs"
            style={{ color: 'var(--text-error)' }}
            data-testid="remote-qr-expired"
          >
            {t('remote.qr.expired')}
          </div>
        ) : (
          <>
            <div
              data-testid="remote-pair-code"
              className="mono rounded-lg border px-4 py-3 text-center text-2xl font-semibold tracking-[0.18em] text-pri"
              style={{ borderColor: 'var(--border)' }}
            >
              {ticket.code}
            </div>
            <div className="text-xs text-ter" data-testid="remote-qr-countdown">
              {t('remote.qr.expiresIn', { seconds: remaining })}
            </div>
          </>
        )}
        <div className="flex gap-2">
          {expired ? (
            <button
              type="button"
              data-testid="remote-qr-regenerate"
              onClick={() => void start()}
              disabled={starting}
              className="icon-btn icon-btn--primary"
            >
              {t('remote.qr.regenerate')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="remote-qr-cancel"
            onClick={() => setTicket(null)}
            className="icon-btn"
          >
            {t('remote.qr.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
