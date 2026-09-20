import { Bell, Check, ChevronDown, Info, Play, Volume2, VolumeX } from 'lucide-react'
import { useMemo } from 'react'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import type {
  NotificationDetail,
  NotificationSound,
} from '../notifications/NotificationProvider.js'
import { useNotifications } from '../notifications/NotificationProvider.js'

interface SoundOption {
  accent: string
  descriptionKey: TranslationKey
  labelKey: TranslationKey
  length: 'short' | 'long' | 'silent'
  value: NotificationSound
}

interface DetailOption {
  descriptionKey: TranslationKey
  labelKey: TranslationKey
  value: NotificationDetail
}

const SOUND_OPTIONS: SoundOption[] = [
  {
    accent: 'var(--status-green)',
    descriptionKey: 'notifications.sound.soft.description',
    labelKey: 'notifications.sound.soft.label',
    length: 'short',
    value: 'soft',
  },
  {
    accent: 'var(--status-blue)',
    descriptionKey: 'notifications.sound.ping.description',
    labelKey: 'notifications.sound.ping.label',
    length: 'short',
    value: 'ping',
  },
  {
    accent: 'var(--status-gold)',
    descriptionKey: 'notifications.sound.chime.description',
    labelKey: 'notifications.sound.chime.label',
    length: 'short',
    value: 'chime',
  },
  {
    accent: 'var(--accent)',
    descriptionKey: 'notifications.sound.cascade.description',
    labelKey: 'notifications.sound.cascade.label',
    length: 'long',
    value: 'cascade',
  },
  {
    accent: 'var(--status-orange)',
    descriptionKey: 'notifications.sound.beacon.description',
    labelKey: 'notifications.sound.beacon.label',
    length: 'long',
    value: 'beacon',
  },
  {
    accent: 'var(--status-purple)',
    descriptionKey: 'notifications.sound.resolve.description',
    labelKey: 'notifications.sound.resolve.label',
    length: 'long',
    value: 'resolve',
  },
  {
    accent: 'var(--text-tertiary)',
    descriptionKey: 'notifications.sound.off.description',
    labelKey: 'notifications.sound.off.label',
    length: 'silent',
    value: 'off',
  },
]

const DETAIL_OPTIONS: DetailOption[] = [
  {
    descriptionKey: 'notifications.detail.brief.description',
    labelKey: 'notifications.detail.brief.label',
    value: 'brief',
  },
  {
    descriptionKey: 'notifications.detail.detailed.description',
    labelKey: 'notifications.detail.detailed.label',
    value: 'detailed',
  },
]

export const NotificationSettings = () => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const { notify, previewSound, requestDesktopNotifications, settings, updateSettings } =
    useNotifications()
  const desktopUnsupported = typeof window !== 'undefined' && !('Notification' in window)

  const soundOptions = useMemo(
    () =>
      SOUND_OPTIONS.map((option) => ({
        ...option,
        description: t(option.descriptionKey),
        label: t(option.labelKey),
      })),
    [t]
  )
  const detailOptions = useMemo(
    () =>
      DETAIL_OPTIONS.map((option) => ({
        ...option,
        description: t(option.descriptionKey),
        label: t(option.labelKey),
      })),
    [t]
  )

  const handleDesktopChange = (checked: boolean) => {
    if (!checked) {
      updateSettings({ desktop: false })
      return
    }
    void requestDesktopNotifications()
  }

  return (
    <details className="settings-details group">
      <summary className="settings-details__summary">
        <div className="settings-section__heading !mb-0">
          <Bell size={12} aria-hidden />
          <span>{t('notifications.settings.heading')}</span>
        </div>
        <ChevronDown
          size={14}
          className="text-sec transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="settings-details__content flex flex-col gap-3.5">
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-ter text-[10px] font-semibold uppercase tracking-wider">
            <Volume2 size={12} aria-hidden />
            {t('notifications.sound.sectionLabel')}
          </div>
          <div
            role="radiogroup"
            aria-label={t('notifications.sound.sectionLabel')}
            className={isMobile ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-2 gap-2'}
          >
            {soundOptions.map((item) => (
              <div
                key={item.value}
                className="relative min-h-[78px] rounded border transition-colors"
                style={{
                  background:
                    settings.sound === item.value
                      ? `color-mix(in oklab, ${item.accent} 10%, var(--bg-2))`
                      : 'var(--bg-2)',
                  borderColor:
                    settings.sound === item.value
                      ? `color-mix(in oklab, ${item.accent} 54%, var(--border-bright))`
                      : 'var(--border)',
                }}
              >
                <label className="block h-full w-full cursor-pointer rounded px-3 py-2 pr-10 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]">
                  <input
                    type="radio"
                    name="notification-sound"
                    value={item.value}
                    checked={settings.sound === item.value}
                    className="sr-only"
                    onChange={() => updateSettings({ sound: item.value })}
                  />
                  <span className="mb-1 flex items-center gap-2">
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded"
                      style={{
                        background: `color-mix(in oklab, ${item.accent} 16%, transparent)`,
                        color: item.accent,
                      }}
                    >
                      {item.value === 'off' ? (
                        <VolumeX size={12} aria-hidden />
                      ) : (
                        <Volume2 size={12} aria-hidden />
                      )}
                    </span>
                    <span className="font-medium text-pri text-xs">{item.label}</span>
                    {item.length === 'long' ? (
                      <span className="rounded border border-[var(--border-bright)] px-1.5 py-0.5 text-[10px] text-ter uppercase">
                        {t('notifications.sound.longerBadge')}
                      </span>
                    ) : null}
                    {settings.sound === item.value ? (
                      <Check size={12} className="ml-auto text-pri" aria-hidden />
                    ) : null}
                  </span>
                  <span className="block text-ter text-[11px] leading-relaxed">
                    {item.description}
                  </span>
                </label>
                {item.value !== 'off' ? (
                  <button
                    type="button"
                    aria-label={t('notifications.sound.previewAria', { label: item.label })}
                    className="absolute right-2 bottom-2 flex h-6 w-6 pointer-coarse:h-10 pointer-coarse:w-10 items-center justify-center rounded border text-sec transition-colors hover:bg-3 hover:text-pri cursor-pointer"
                    style={{ borderColor: 'var(--border-bright)' }}
                    onClick={() => previewSound(item.value)}
                  >
                    <Play size={12} aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center gap-1.5 text-ter text-[10px] font-semibold uppercase tracking-wider">
            <Info size={12} aria-hidden />
            {t('notifications.detail.sectionLabel')}
          </div>
          <div
            role="radiogroup"
            aria-label={t('notifications.detail.sectionLabel')}
            className="grid grid-cols-2 rounded border p-1"
            style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
          >
            {detailOptions.map((item) => (
              <label
                key={item.value}
                className="cursor-pointer rounded px-3 py-2 text-left transition-colors hover:bg-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-[var(--ring-focus)]"
                style={{
                  background: settings.detail === item.value ? 'var(--bg-3)' : 'transparent',
                  color:
                    settings.detail === item.value
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                }}
              >
                <input
                  type="radio"
                  name="notification-detail"
                  value={item.value}
                  checked={settings.detail === item.value}
                  className="sr-only"
                  onChange={() => updateSettings({ detail: item.value })}
                />
                <span className="block font-medium text-xs">{item.label}</span>
                <span className="block text-ter text-[11px] leading-relaxed">
                  {item.description}
                </span>
              </label>
            ))}
          </div>
        </section>

        <label className="flex items-start gap-2 rounded border p-2 text-sec text-xs cursor-pointer">
          <input
            type="checkbox"
            aria-label={t('notifications.desktop.aria')}
            checked={settings.desktop}
            disabled={desktopUnsupported}
            className="mt-0.5 cursor-pointer"
            onChange={(event) => handleDesktopChange(event.currentTarget.checked)}
          />
          <span>
            <span className="block font-medium text-pri">{t('notifications.desktop.label')}</span>
            <span className="text-ter leading-relaxed">
              {desktopUnsupported
                ? t('notifications.desktop.unsupported')
                : t('notifications.desktop.helper')}
            </span>
          </span>
        </label>

        <div
          className="flex justify-end gap-2 border-t pt-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            className="icon-btn icon-btn--primary ml-auto cursor-pointer"
            onClick={() =>
              notify({
                brief: t('notifications.test.brief'),
                detail: t('notifications.test.detail'),
                kind: 'success',
                title: t('notifications.test.title'),
              })
            }
          >
            {t('notifications.test.button')}
          </button>
        </div>
      </div>
    </details>
  )
}
