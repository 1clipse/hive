import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Play, X } from 'lucide-react'
import { useLayoutEffect } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { getMobileFocusMode, setMobileFocusMode } from '../mobile/focus-mode.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'
import { getRolePresentation } from './role-presentation.js'
import { useWorkerModalResize, WORKER_MODAL_MIN } from './useWorkerModalResize.js'
import { presentWorkerRuntimeStatus } from './worker-status.js'

type WorkerModalProps = {
  onClose: () => void
  onStart: (worker: TeamListItem) => void
  runId: string | null
  startError: string | null
  starting: boolean
  worker: TeamListItem
}

/**
 * Worker detail dialog — pure PTY view. All control actions (Stop / Restart /
 * Delete / Start) live on the WorkerCard's hover cluster now; this dialog
 * only handles "watch the terminal" + "close". The empty-state Start button
 * is the lone exception so a stopped agent is restartable from inside.
 */
export const WorkerModal = ({
  onClose,
  onStart,
  runId,
  startError,
  starting,
  worker,
}: WorkerModalProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const role = getRolePresentation(worker.role)
  const ptyRunning = !!runId
  const status = presentWorkerRuntimeStatus(ptyRunning)
  const resize = useWorkerModalResize()

  useLayoutEffect(() => {
    if (!isMobile) return
    const previous = getMobileFocusMode()
    setMobileFocusMode(true)
    return () => setMobileFocusMode(previous)
  }, [isMobile])

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="worker-modal-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center">
          <Dialog.Content
            data-testid="worker-modal"
            aria-label={t('worker.detail', { name: worker.name })}
            className="dialog-scale-pop pointer-events-auto relative flex h-screen max-h-screen max-w-full flex-col overflow-hidden"
            data-mobile={isMobile || undefined}
            onEscapeKeyDown={(event) => event.preventDefault()}
            style={
              isMobile
                ? { background: 'var(--bg-1)' }
                : { background: 'var(--bg-1)', width: `${resize.width}px` }
            }
          >
            {/* Desktop-only width resize. A phone modal is full-screen — drag
                strips at the edges would just fight the user's taps. */}
            {isMobile ? null : (
              <>
                {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('worker.widthResize')}
                  aria-valuemin={WORKER_MODAL_MIN}
                  aria-valuenow={Math.round(resize.width)}
                  className="modal-resize-handle modal-resize-handle--left"
                  tabIndex={-1}
                  data-resizing={resize.resizing || undefined}
                  onPointerDown={resize.beginResize('left')}
                />
                {/* biome-ignore lint/a11y/useSemanticElements: aria role="separator" is the canonical resize-handle role */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('worker.widthResize')}
                  aria-valuemin={WORKER_MODAL_MIN}
                  aria-valuenow={Math.round(resize.width)}
                  className="modal-resize-handle modal-resize-handle--right"
                  tabIndex={-1}
                  data-resizing={resize.resizing || undefined}
                  onPointerDown={resize.beginResize('right')}
                />
              </>
            )}
            <Dialog.Title className="sr-only">{worker.name}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {role.label} agent — status {status.label}
            </Dialog.Description>

            {startError ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs"
                style={{
                  background: 'color-mix(in oklab, var(--status-red) 10%, transparent)',
                  borderColor: 'color-mix(in oklab, var(--status-red) 30%, var(--border))',
                  color: 'var(--status-red)',
                }}
              >
                <AlertTriangle size={12} aria-hidden />
                <span className="break-words">{startError}</span>
              </div>
            ) : null}

            {isMobile ? null : (
              <div
                className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded border px-2 py-1 text-[11px]"
                data-testid="worker-modal-close-hint"
                style={{
                  background: 'color-mix(in oklab, var(--bg-1) 88%, transparent)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {t('worker.closeOutsideHint')}
              </div>
            )}

            {/* Phones: no control strip (user call 2026-06) — the member sheet
                on the Team list owns Stop/Restart/etc. Desktop closes via the
                outside overlay; mobile stays full-screen, so it still needs a
                visible close affordance. */}
            <div
              className={`relative flex min-h-0 flex-1 flex-col${isMobile ? '' : ' p-3'}`}
              data-testid="worker-modal-terminal-slot"
            >
              {isMobile ? (
                <Tooltip label={t('common.close')}>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close worker detail"
                      data-testid="worker-modal-close"
                      className="float-action absolute top-2 right-2 z-10"
                      style={{ minHeight: 44, minWidth: 44 }}
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </Dialog.Close>
                </Tooltip>
              ) : (
                <Tooltip label={t('common.close')}>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close worker detail"
                      data-testid="worker-modal-close"
                      className="sr-only"
                    >
                      {t('common.close')}
                    </button>
                  </Dialog.Close>
                </Tooltip>
              )}

              <div
                className={`flex min-h-0 flex-1${isMobile ? '' : ' rounded-lg border'}`}
                style={{ background: 'var(--bg-crust)', borderColor: 'var(--border)' }}
              >
                {ptyRunning ? (
                  <div
                    id={`worker-pty-${runId}`}
                    className="flex h-full w-full"
                    data-pty-slot="worker"
                    data-terminal-auto-focus="true"
                  />
                ) : (
                  <div className="m-auto flex max-w-[400px] flex-col items-center gap-3 px-6 text-center">
                    <CliAgentAvatar
                      commandPresetId={worker.commandPresetId}
                      customAvatar={worker.avatar}
                      workerRole={worker.role}
                      size={48}
                    />
                    <div className="text-sm text-pri">{worker.name}</div>
                    <div className="text-xs text-ter">
                      {worker.status === 'stopped'
                        ? t('worker.terminalStopped')
                        : t('worker.terminalNotStarted')}
                      {t('worker.startAgent')}
                    </div>
                    <button
                      type="button"
                      onClick={() => onStart(worker)}
                      disabled={starting}
                      className="icon-btn icon-btn--primary"
                      data-testid="worker-start-empty"
                    >
                      <Play size={12} aria-hidden />{' '}
                      {starting ? t('common.starting') : t('common.start')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
