import { Check, ChevronDown, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../i18n.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { logSwallowed } from '../lib/log-swallowed.js'
import { getCliInstallGuidance } from './cli-install-commands.js'

type CliInstallGuidancePanelProps = {
  /** Command-preset id (`claude`, `codex`, …) used to look up the install command. */
  presetId: string
  /** Display name shown in the "Install {name}:" hint. */
  presetName: string
}

/**
 * Shown under the preset select when the chosen CLI is not on the server's
 * PATH (growth research P0-B1). Gives the official install one-liner with a
 * copy button, a docs link, and an expandable "installed but not found?"
 * explainer for the PATH-mismatch trap (nvm / GUI launch).
 */
export const CliInstallGuidancePanel = ({ presetId, presetName }: CliInstallGuidancePanelProps) => {
  const { t } = useI18n()
  const guidance = getCliInstallGuidance(presetId)
  const [copied, setCopied] = useState(false)
  const [helpExpanded, setHelpExpanded] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    },
    []
  )

  const handleCopy = () => {
    if (!guidance) return
    void copyTextToClipboard(guidance.command)
      .then(() => {
        setCopied(true)
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          setCopied(false)
          copyTimerRef.current = null
        }, 1500)
      })
      .catch(logSwallowed('cli-install-copy'))
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-3"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      data-testid="cli-install-guidance"
    >
      {guidance ? (
        <>
          <span className="text-xs text-sec">
            {t('workspace.preset.installHint', { name: presetName })}
          </span>
          <div className="flex items-center gap-2">
            <code
              className="mono min-w-0 flex-1 truncate rounded border px-2 py-1.5 text-xs text-pri"
              style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
              title={guidance.command}
            >
              {guidance.command}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="icon-btn shrink-0 inline-flex items-center gap-1.5"
              aria-label={t('workspace.preset.installCopyAria')}
              data-testid="cli-install-copy"
            >
              {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              <span className="text-xs">
                {copied ? t('common.copied') : t('workspace.preset.installCopy')}
              </span>
            </button>
          </div>
          <a
            href={guidance.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start text-xs text-sec underline hover:text-pri"
            data-testid="cli-install-docs"
          >
            <ExternalLink size={11} aria-hidden />
            {t('workspace.preset.installDocs')}
          </a>
        </>
      ) : null}
      <button
        type="button"
        onClick={() => setHelpExpanded((value) => !value)}
        aria-expanded={helpExpanded}
        className="flex items-center gap-1 text-left text-xs text-sec hover:text-pri cursor-pointer"
        data-testid="cli-install-path-help-toggle"
      >
        {helpExpanded ? (
          <ChevronDown size={12} aria-hidden />
        ) : (
          <ChevronRight size={12} aria-hidden />
        )}
        {t('workspace.preset.pathHelpTitle')}
      </button>
      {helpExpanded ? (
        <p className="text-xs leading-relaxed text-ter" data-testid="cli-install-path-help-body">
          {t('workspace.preset.pathHelpBody')}
        </p>
      ) : null}
    </div>
  )
}
