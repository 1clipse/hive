import { Check, Copy, ExternalLink, Package, X } from 'lucide-react'
import { useState } from 'react'

import type { VersionInfo } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { APP_VERSION } from '../version.js'

const DISMISSED_VERSION_KEY = 'hive.package-update.dismissed-version'

const readDismissedVersion = (): string | null => {
  try {
    return window.localStorage.getItem(DISMISSED_VERSION_KEY)
  } catch {
    return null
  }
}

const writeDismissedVersion = (version: string): void => {
  try {
    window.localStorage.setItem(DISMISSED_VERSION_KEY, version)
  } catch {
    // localStorage is best-effort UI state; the toast can still dismiss in-memory.
  }
}

interface PackageUpdateToastProps {
  currentVersion?: string
  versionInfo: VersionInfo | null
}

export const PackageUpdateToast = ({
  currentVersion = APP_VERSION,
  versionInfo,
}: PackageUpdateToastProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissedVersion)
  const [copyState, setCopyState] = useState<'copied' | 'error' | 'idle'>('idle')

  const updateInfo =
    versionInfo?.updateAvailable && versionInfo.latestVersion !== currentVersion
      ? versionInfo
      : null

  if (!updateInfo || dismissedVersion === updateInfo.latestVersion) return null

  const hasUpdateCommand = Boolean(updateInfo.installHint)
  const copyLabel =
    copyState === 'copied'
      ? t('packageUpdate.commandCopied')
      : copyState === 'error'
        ? t('packageUpdate.commandCopyFailed')
        : t('packageUpdate.copyCommand')

  const dismiss = () => {
    writeDismissedVersion(updateInfo.latestVersion)
    setDismissedVersion(updateInfo.latestVersion)
  }

  const copyUpdateCommand = async () => {
    if (!updateInfo.installHint) return
    try {
      await navigator.clipboard.writeText(updateInfo.installHint)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
    } catch {
      setCopyState('error')
      window.setTimeout(() => setCopyState('idle'), 2200)
    }
  }

  return (
    <div
      className="package-update-toast elev-2 toast-pop fixed right-4 bottom-24 z-50 flex w-[min(420px,calc(100vw-2rem))] items-start gap-3 rounded border px-3 py-2.5"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
      data-mobile={isMobile || undefined}
      data-testid="package-update-toast"
      role="status"
      aria-live="polite"
    >
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border"
        style={{
          background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
          borderColor: 'color-mix(in oklab, var(--accent) 28%, transparent)',
          color: 'var(--accent)',
        }}
        aria-hidden
      >
        <Package size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-pri text-xs">
          {t('packageUpdate.title', { version: updateInfo.latestVersion })}
        </div>
        <div className="mt-0.5 text-ter text-xs">
          {t('packageUpdate.body', {
            current: currentVersion,
            latest: updateInfo.latestVersion,
          })}
        </div>
        {hasUpdateCommand ? (
          <code
            className="mono mt-2 block truncate rounded border px-2 py-1 text-ter text-xs"
            title={updateInfo.updateNote || updateInfo.installHint}
            style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
          >
            {updateInfo.installHint}
          </code>
        ) : updateInfo.updateNote ? (
          <div className="mt-2 text-ter text-xs">{updateInfo.updateNote}</div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {hasUpdateCommand ? (
            <button
              type="button"
              className="icon-btn icon-btn--primary"
              data-testid="package-update-copy-command"
              onClick={copyUpdateCommand}
              aria-label={copyLabel}
              title={copyLabel}
            >
              {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
              <span>{copyLabel}</span>
            </button>
          ) : null}
          {updateInfo.releaseUrl ? (
            <a
              href={updateInfo.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="icon-btn"
              data-testid="package-update-open-release"
              aria-label={t('packageUpdate.openRelease')}
              title={t('packageUpdate.openRelease')}
            >
              <ExternalLink size={13} />
              <span>{t('packageUpdate.release')}</span>
            </a>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            data-testid="package-update-dismiss"
            onClick={dismiss}
          >
            {t('packageUpdate.later')}
          </button>
        </div>
      </div>
      <Tooltip label={t('common.dismiss')}>
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-ter transition-colors hover:bg-3 hover:text-pri focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          data-testid="package-update-close"
          onClick={dismiss}
          aria-label={t('common.dismiss')}
        >
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  )
}
