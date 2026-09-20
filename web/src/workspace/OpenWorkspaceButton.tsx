import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceSummary } from '../../../src/shared/types.js'
import { type OpenWorkspaceResult, openWorkspaceInEditor } from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'
import { useLayoutMode } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import {
  getOpenTargetOption,
  getOpenTargetOptions,
  loadPersistedOpenTargetId,
  type OpenTargetId,
  persistOpenTargetId,
  resolveOpenTargetPlatform,
} from './open-targets.js'

interface OpenWorkspaceButtonProps {
  workspace: WorkspaceSummary | null | undefined
}

const ERROR_TOAST_KEY: Record<
  Exclude<OpenWorkspaceResult & { ok: false }, never>['errorCode'],
  TranslationKey
> = {
  'app-not-installed': 'openWorkspace.error.appNotInstalled',
  'command-not-in-path': 'openWorkspace.error.commandNotInPath',
  'invalid-path': 'openWorkspace.error.invalidPath',
  'invalid-target': 'openWorkspace.error.invalidTarget',
  unknown: 'openWorkspace.error.unknown',
}

export const OpenWorkspaceButton = ({ workspace }: OpenWorkspaceButtonProps) => {
  const { t } = useI18n()
  const { mode } = useLayoutMode()
  const toast = useToast()
  const platform = useMemo(() => resolveOpenTargetPlatform(), [])
  const options = getOpenTargetOptions(platform)
  const [selectedId, setSelectedId] = useState<OpenTargetId>(() =>
    loadPersistedOpenTargetId(platform)
  )
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mainButtonRef = useRef<HTMLButtonElement>(null)

  const selectedOption = getOpenTargetOption(selectedId, platform)
  const selectedLabel = t(selectedOption.labelKey)

  useEffect(() => {
    if (!popoverOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    const handlePointer = (event: PointerEvent) => {
      const root = containerRef.current
      if (root && !root.contains(event.target as Node)) setPopoverOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handlePointer)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handlePointer)
    }
  }, [popoverOpen])

  const handleSelect = useCallback((targetId: OpenTargetId) => {
    setSelectedId(targetId)
    persistOpenTargetId(targetId)
    setPopoverOpen(false)
    mainButtonRef.current?.focus()
  }, [])

  const handleOpen = useCallback(async () => {
    if (!workspace || isOpening) return
    setIsOpening(true)
    try {
      const result = await openWorkspaceInEditor(workspace.id, selectedId)
      if (!result.ok) {
        const labelKey = getOpenTargetOption(result.effectiveTargetId, platform).labelKey
        toast.show({
          kind: 'error',
          message: t(ERROR_TOAST_KEY[result.errorCode], { app: t(labelKey) }),
        })
      } else if (mode === 'mobile') {
        // The editor opens on the HOST machine — a phone user has no window appearing as feedback,
        // so confirm the dispatch with a result toast. Desktop stays quiet (the window IS the signal).
        const labelKey = getOpenTargetOption(result.effectiveTargetId, platform).labelKey
        toast.show({
          kind: 'success',
          message: t('openWorkspace.opened', { app: t(labelKey), workspace: workspace.name }),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message })
    } finally {
      setIsOpening(false)
    }
  }, [isOpening, mode, platform, selectedId, t, toast, workspace])

  const disabled = !workspace
  const disabledTooltip = t('openWorkspace.noWorkspace')
  const mainTooltip = workspace
    ? t('openWorkspace.openIn', { app: selectedLabel, workspace: workspace.name })
    : disabledTooltip

  const mainAriaLabel = workspace
    ? t('openWorkspace.openInAria', { app: selectedLabel, workspace: workspace.name })
    : disabledTooltip

  return (
    <div ref={containerRef} className="open-workspace relative flex">
      <Tooltip label={mainTooltip}>
        <span className="flex">
          <button
            ref={mainButtonRef}
            type="button"
            aria-label={mainAriaLabel}
            data-testid="topbar-open-workspace"
            disabled={disabled || isOpening}
            onClick={() => void handleOpen()}
            className="open-workspace__main"
          >
            <span className="open-workspace__trigger-icon" aria-hidden>
              {isOpening ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <img
                  src={selectedOption.iconSrc}
                  alt=""
                  className="open-workspace__trigger-img"
                  style={{
                    transform: selectedOption.iconScale
                      ? `scale(${selectedOption.iconScale})`
                      : undefined,
                  }}
                />
              )}
            </span>
            <span>{t('openWorkspace.open')}</span>
          </button>
        </span>
      </Tooltip>
      <Tooltip label={t('openWorkspace.selectTarget')}>
        <button
          type="button"
          aria-label={t('openWorkspace.selectTarget')}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          data-testid="topbar-open-workspace-chevron"
          disabled={disabled}
          onClick={() => setPopoverOpen((value) => !value)}
          className="open-workspace__chevron"
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      </Tooltip>
      {popoverOpen ? (
        <div
          role="menu"
          aria-label={t('openWorkspace.selectTarget')}
          className="open-workspace__menu elev-2"
          data-testid="topbar-open-workspace-menu"
        >
          {options.map((option) => {
            const isSelected = option.id === selectedId
            return (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={isSelected}
                type="button"
                onClick={() => handleSelect(option.id)}
                className="open-workspace__option"
                data-selected={isSelected ? 'true' : undefined}
                data-testid={`topbar-open-workspace-option-${option.id}`}
              >
                <span className="open-workspace__option-icon" aria-hidden>
                  <img
                    src={option.iconSrc}
                    alt=""
                    className="open-workspace__option-img"
                    style={{
                      transform: option.iconScale ? `scale(${option.iconScale})` : undefined,
                    }}
                  />
                </span>
                <span className="flex-1">{t(option.labelKey)}</span>
                <span className="open-workspace__check" aria-hidden>
                  {isSelected ? <Check size={13} /> : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
