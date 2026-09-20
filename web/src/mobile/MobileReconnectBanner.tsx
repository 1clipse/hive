import { type TranslationKey, useI18n } from '../i18n.js'
import type { ConnectionStatus } from '../transport/api-transport.js'

interface MobileReconnectBannerProps {
  status: ConnectionStatus | null
}

const BANNER_KEYS: Record<'disconnected' | 'reconnecting' | 'revoked', TranslationKey> = {
  disconnected: 'mobile.reconnect.disconnected',
  reconnecting: 'mobile.reconnect.reconnecting',
  revoked: 'mobile.reconnect.revoked',
}

export const MobileReconnectBanner = ({ status }: MobileReconnectBannerProps) => {
  const { t } = useI18n()
  if (
    !status ||
    (status.state !== 'reconnecting' &&
      status.state !== 'disconnected' &&
      status.state !== 'revoked')
  ) {
    return null
  }

  const tone = status.state === 'revoked' ? 'var(--status-red)' : 'var(--status-orange)'
  const retry = status.state === 'disconnected' ? status.retry : undefined

  return (
    <div
      role="status"
      data-testid="mobile-reconnect-banner"
      className="flex items-center justify-center gap-2 px-3 py-1.5 text-center text-xs"
      style={{
        background: `color-mix(in oklab, ${tone} 18%, var(--bg-0))`,
        color: tone,
      }}
    >
      <span>{t(BANNER_KEYS[status.state])}</span>
      {retry ? (
        <button
          type="button"
          data-testid="mobile-reconnect-retry"
          className="rounded border px-2 py-0.5 font-medium"
          style={{ borderColor: 'currentColor', color: 'currentColor' }}
          onClick={retry}
        >
          {t('mobile.reconnect.retry')}
        </button>
      ) : null}
    </div>
  )
}
