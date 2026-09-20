import * as Dialog from '@radix-ui/react-dialog'
import { Check, ImageIcon, X } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { WorkerAvatarPicker } from './WorkerAvatarPicker.js'

type WorkerAvatarDialogProps = {
  onClose: () => void
  onSave: (avatar: string | null) => Promise<{ error: string | null }>
  worker: TeamListItem
}

export const WorkerAvatarDialog = ({ onClose, onSave, worker }: WorkerAvatarDialogProps) => {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [avatar, setAvatar] = useState<string | null>(worker.avatar ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = avatar !== (worker.avatar ?? null)

  const save = () => {
    setSaving(true)
    setError(null)
    void onSave(avatar)
      .then((result) => {
        if (result.error) {
          setError(result.error)
          return
        }
        onClose()
      })
      .catch((saveError) =>
        setError(saveError instanceof Error ? saveError.message : String(saveError))
      )
      .finally(() => setSaving(false))
  }

  return (
    <Dialog.Root open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 max-md:items-end max-md:p-0">
          <Dialog.Content
            className={`${isMobile ? 'dialog-slide-up max-md:w-full max-md:rounded-b-none max-md:rounded-t-xl' : 'dialog-scale-pop w-[440px] max-w-full'} worker-avatar-dialog elev-2 pointer-events-auto flex flex-col`}
          >
            <div className="worker-avatar-dialog__header">
              <span className="worker-avatar-dialog__mark" aria-hidden>
                <ImageIcon size={16} />
              </span>
              <div className="worker-avatar-dialog__heading">
                <Dialog.Title className="worker-avatar-dialog__title">
                  {t('worker.avatarTitle')}
                </Dialog.Title>
                <Dialog.Description className="worker-avatar-dialog__subtitle">
                  {worker.name}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('common.closeDialog')}
                  className="icon-btn icon-btn--ghost h-8 w-8 px-0 justify-center"
                >
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </div>

            <div className="worker-avatar-dialog__body">
              <WorkerAvatarPicker
                avatar={avatar}
                commandPresetId={worker.commandPresetId}
                disabled={saving}
                onChange={setAvatar}
                workerRole={worker.role}
                showStatus
              />

              {error ? <div className="worker-avatar-dialog__error">{error}</div> : null}
            </div>

            <div className="worker-avatar-dialog__footer">
              <button type="button" className="icon-btn" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--primary"
                disabled={!changed || saving}
                onClick={save}
              >
                <Check size={14} aria-hidden />
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
