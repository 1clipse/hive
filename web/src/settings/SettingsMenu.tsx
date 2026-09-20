import { FlaskConical, Settings, Webhook, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { getWebhookUrl, saveWebhookUrl } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { RemoteAccessSection } from '../remote/RemoteAccessSection.js'
import { Switch } from '../ui/Switch.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useWorkflowFeature } from '../workflows/useWorkflowFeature.js'
import { LanguageSetting } from './LanguageSetting.js'

interface ToggleFeature {
  enabled: boolean
  loading: boolean
  setEnabled: (enabled: boolean) => Promise<void>
}

/** One experimental on/off row backed by a feature hook; owns its own
 *  saving/error state so a failed save surfaces instead of looking saved. */
const ExperimentalToggle = ({
  feature,
  label,
  description,
  testId,
}: {
  feature: ToggleFeature
  label: string
  description: string
  testId: string
}) => {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  const handleToggle = async (checked: boolean) => {
    setSaveError(false)
    setSaving(true)
    try {
      await feature.setEnabled(checked)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click handler on row for mouse users; Switch button provides keyboard access
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler on row for mouse users; Switch button provides keyboard access
    <div
      className="settings-toggle-row"
      onClick={() => {
        if (!feature.loading && !saving) void handleToggle(!feature.enabled)
      }}
    >
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-medium text-pri">{label}</span>
        <span className="mt-0.5 block text-xs text-ter leading-relaxed">{description}</span>
        {saveError ? (
          <span className="mt-1 block text-xs" style={{ color: 'var(--text-error)' }} role="alert">
            {t('settings.saveError')}
          </span>
        ) : null}
      </span>
      <div className="mt-0.5 shrink-0">
        <Switch
          checked={feature.enabled}
          disabled={feature.loading || saving}
          onChange={(checked) => void handleToggle(checked)}
          data-testid={testId}
          aria-label={label}
        />
      </div>
    </div>
  )
}

/** Single text field for the outbound completion webhook URL. Loads on mount,
 *  saves on blur; surfaces a saved/error hint so a failed write isn't silent. */
const WebhookUrlField = () => {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'saved' | 'error' | null>(null)

  useEffect(() => {
    let cancelled = false
    void getWebhookUrl()
      .then((url) => {
        if (!cancelled) {
          setValue(url)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    setStatus(null)
    setSaving(true)
    try {
      await saveWebhookUrl(value)
      setStatus('saved')
    } catch {
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-pri" htmlFor="settings-webhook-url">
        {t('settings.webhook.label')}
      </label>
      <span className="mb-2 block text-xs text-ter leading-relaxed">
        {t('settings.webhook.description')}
      </span>
      <input
        id="settings-webhook-url"
        type="url"
        inputMode="url"
        placeholder="https://…"
        className="input"
        value={value}
        disabled={!loaded || saving}
        onChange={(event) => {
          setStatus(null)
          setValue(event.target.value)
        }}
        onBlur={() => {
          void save()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            event.currentTarget.blur()
          }
        }}
        data-testid="settings-webhook-url"
      />
      {status === 'saved' ? (
        <span className="mt-1.5 block text-xs" style={{ color: 'var(--status-green)' }}>
          ✓ {t('settings.webhook.saved')}
        </span>
      ) : null}
      {status === 'error' ? (
        <span className="mt-1.5 block text-xs" style={{ color: 'var(--text-error)' }} role="alert">
          {t('settings.saveError')}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The settings body — experimental feature toggles, the completion webhook, and
 * the Remote access + device-management section. Shared verbatim by the desktop
 * popover (SettingsMenu) and the mobile Settings tab (MobileSettingsSection) so
 * the two can never drift.
 */
export const SettingsContent = () => {
  const { t } = useI18n()
  const workflow = useWorkflowFeature()
  return (
    <div className="flex flex-col gap-2.5">
      {/* Language settings */}
      <LanguageSetting />

      {/* Experimental features */}
      <div className="settings-section">
        <div className="settings-section__heading">
          <FlaskConical size={12} aria-hidden />
          <span>{t('settings.experimental')}</span>
        </div>

        <ExperimentalToggle
          feature={workflow}
          label={t('settings.workflows.label')}
          description={t('settings.workflows.description')}
          testId="settings-toggle-workflows"
        />
      </div>

      {/* Remote access */}
      <RemoteAccessSection />

      {/* Completion Webhook */}
      <div className="settings-section">
        <div className="settings-section__heading">
          <Webhook size={12} aria-hidden />
          <span>{t('settings.webhook.label')}</span>
        </div>
        <WebhookUrlField />
      </div>
    </div>
  )
}

/**
 * Top-right ⚙ menu for app-level settings. Houses the experimental feature
 * toggle (Workflows) and the completion webhook. Manual popover +
 * outside-click/Escape close, matching NotificationSettingsButton.
 */
export const SettingsMenu = () => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    const handlePointer = (event: PointerEvent) => {
      const root = containerRef.current
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handlePointer)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <Tooltip label={t('settings.tooltip')}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('settings.aria')}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-sec hover:bg-3 hover:text-pri"
          data-testid="topbar-app-settings"
          onClick={() => setOpen((value) => !value)}
        >
          <Settings size={14} aria-hidden />
        </button>
      </Tooltip>
      {open ? (
        <div
          role="dialog"
          aria-label={t('settings.aria')}
          // Desktop: an anchored popover. Mobile: a full-screen sheet so the
          // body (which can grow past a phone viewport with the Remote section
          // expanded) scrolls instead of clipping behind a 360px fixed card.
          className={
            isMobile
              ? 'settings-sheet fixed inset-0 z-50 flex flex-col overflow-y-auto p-4'
              : 'settings-popover elev-2 absolute top-8 right-0 z-50 w-[380px] max-h-[calc(100vh-64px)] overflow-y-auto scroll-y rounded-lg border p-4'
          }
          data-mobile={isMobile || undefined}
          style={
            isMobile
              ? { background: 'var(--bg-0)' }
              : { background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }
          }
          data-testid="app-settings-menu"
        >
          {/* Header */}
          <div className="mb-4 flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                color: 'var(--accent)',
              }}
            >
              <Settings size={18} aria-hidden />
            </div>
            <div className={isMobile ? 'min-w-0 flex-1' : 'min-w-0'}>
              <div className="text-sm font-semibold text-pri">{t('settings.heading')}</div>
              <div className="text-xs text-ter">{t('settings.subtitle')}</div>
            </div>
            {isMobile ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
                data-testid="mobile-settings-close"
                className="icon-btn icon-btn--ghost shrink-0"
              >
                <X size={16} aria-hidden />
              </button>
            ) : null}
          </div>

          <SettingsContent />
        </div>
      ) : null}
    </div>
  )
}
