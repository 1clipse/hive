import * as Dialog from '@radix-ui/react-dialog'
import { Dices, Store, X } from 'lucide-react'
import { type FormEvent, lazy, Suspense, useMemo, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import type { CommandPreset, RoleTemplate } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useToast } from '../ui/useToast.js'
import {
  AgentCliPicker,
  RoleInstructionsField,
  RolePicker,
  RoleTemplatePicker,
  SectionLabel,
  StartupCommandField,
} from './AddWorkerDialogFields.js'
import { WorkerAvatarPicker } from './WorkerAvatarPicker.js'

const MarketplaceDrawer = lazy(() =>
  import('../marketplace/MarketplaceDrawer.js').then((module) => ({
    default: module.MarketplaceDrawer,
  }))
)

type AddWorkerDialogProps = {
  avatar: string | null
  commandPresets: CommandPreset[]
  commandPresetId: string
  creating?: boolean
  customTemplates: RoleTemplate[]
  onApplyMarketplaceImport: (input: { name: string; description: string }) => void
  onAvatarChange: (value: string | null) => void
  onClose: () => void
  onDeleteTemplate: (templateId: string) => Promise<void> | void
  onNameChange: (value: string) => void
  onPresetChange: (value: string) => void
  onRandomName: () => void
  onRoleDescriptionChange: (value: string) => void
  onRoleDescriptionReset: () => void
  onRoleChange: (value: WorkerRole) => void
  onSaveAsTemplate: (name: string) => Promise<void> | void
  onStartupCommandChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTemplateChange: (templateId: string | null) => void
  roleDescription: string
  roleDescriptionDefault: string
  selectedTemplateId: string | null
  startupCommand: string
  templateBusy: boolean
  workerName: string
  workerRole: WorkerRole
  writeDisabledReason?: string
}

export const AddWorkerDialog = ({
  avatar,
  commandPresets,
  commandPresetId,
  creating = false,
  customTemplates,
  onApplyMarketplaceImport,
  onAvatarChange,
  onClose,
  onDeleteTemplate,
  onNameChange,
  onPresetChange,
  onRandomName,
  onRoleDescriptionChange,
  onRoleDescriptionReset,
  onRoleChange,
  onSaveAsTemplate,
  onStartupCommandChange,
  onSubmit,
  onTemplateChange,
  roleDescription,
  roleDescriptionDefault,
  selectedTemplateId,
  startupCommand,
  templateBusy,
  workerName,
  workerRole,
  writeDisabledReason,
}: AddWorkerDialogProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const isMobile = useIsMobile()
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const [marketplaceMounted, setMarketplaceMounted] = useState(false)
  const importedNames = useMemo(
    () => new Set(customTemplates.map((template) => template.name)),
    [customTemplates]
  )
  const handleMarketplaceImport = (detail: { name: string; description: string }) => {
    onApplyMarketplaceImport(detail)
    toast.show({ kind: 'success', message: t('marketplace.imported', { name: detail.name }) })
  }
  const handleClose = (open: boolean) => {
    if (!open) onClose()
  }
  const roleDescriptionModified = roleDescription !== roleDescriptionDefault
  const selectedPreset = commandPresets.find((preset) => preset.id === commandPresetId)
  const startupCommandClean = startupCommand.trim()

  // Validation runs only on submit; we don't pre-disable the Add button so
  // the user always gets actionable feedback (a warning toast) instead of
  // a silently-greyed CTA. Returns the first blocking reason or null.
  const validateBeforeSubmit = (): string | null => {
    if (writeDisabledReason) return writeDisabledReason
    if (!workerName.trim()) return t('addWorker.enterName')
    if (!commandPresetId && !startupCommandClean) return t('addWorker.pickCliOrStartup')
    if (selectedPreset?.available === false && !startupCommandClean) {
      return t('addWorker.unavailable', { name: selectedPreset.displayName })
    }
    if (!roleDescription.trim()) return t('addWorker.emptyInstructions')
    return null
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const reason = validateBeforeSubmit()
    if (reason) {
      event.preventDefault()
      toast.show({ kind: 'warning', message: reason })
      return
    }
    onSubmit(event)
  }

  return (
    <Dialog.Root open onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="add-worker-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 max-md:items-end max-md:p-0">
          <Dialog.Content
            data-testid="add-worker-content"
            data-mobile={isMobile || undefined}
            className={`${isMobile ? 'dialog-slide-up add-worker-sheet' : 'dialog-scale-pop'} elev-2 pointer-events-auto flex max-h-[calc(100vh-32px)] w-[560px] max-w-full flex-col overflow-hidden rounded-lg border pointer-coarse:max-h-[85dvh] max-md:w-full max-md:rounded-b-none max-md:rounded-t-xl`}
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
              // Fixed sheet height: keyboard show/hide resizes the viewport, a
              // fixed 85dvh keeps the form from jumping as sections expand.
              ...(isMobile ? { height: '85dvh' } : {}),
            }}
          >
            <form
              onSubmit={handleSubmit}
              aria-label={t('addWorker.title')}
              className="flex min-h-0 flex-1 flex-col overflow-hidden max-h-full"
            >
              <div
                className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4 max-md:px-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Dialog.Title className="text-lg font-semibold text-pri">
                    {t('addWorker.title')}
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-ter">
                    {t('addWorker.description', { command: 'team send' })}
                  </Dialog.Description>
                </div>
                {/* Phones have no Esc key — give the sheet an explicit close. */}
                {isMobile ? (
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label={t('common.closeDialog')}
                      data-testid="add-worker-close"
                      className="-mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-sec"
                      style={{ background: 'var(--bg-2)' }}
                    >
                      <X size={18} aria-hidden />
                    </button>
                  </Dialog.Close>
                ) : null}
              </div>

              <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4 max-md:gap-5 max-md:px-4">
                <div className="flex flex-col gap-2">
                  <SectionLabel>{t('addWorker.name')}</SectionLabel>
                  <div className="relative flex items-center">
                    <input
                      // biome-ignore lint/a11y/noAutofocus: dialog is opt-in; without this Radix parks focus on the first toolbar button (Random) rather than the name field. On phones we skip it — autofocus pops the keyboard over a sheet the user hasn't read yet.
                      autoFocus={!isMobile}
                      value={workerName}
                      onChange={(event) => onNameChange(event.target.value)}
                      placeholder={t('addWorker.namePlaceholder')}
                      className="input w-full pr-24"
                      style={{ borderRadius: '10px' }}
                    />
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                      <Tooltip label={t('addWorker.randomTooltip')}>
                        <button
                          type="button"
                          aria-label={t('addWorker.randomAria')}
                          className="flex h-7 items-center gap-1.5 rounded-lg border border-bright/10 bg-3 px-2.5 text-xs font-semibold text-sec hover:text-pri hover:bg-4 active:scale-95 transition-all outline-none"
                          onClick={onRandomName}
                          data-testid="random-worker-name"
                        >
                          <Dices size={13} aria-hidden />
                          <span>{t('addWorker.random')}</span>
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>

                <RolePicker workerRole={workerRole} onRoleChange={onRoleChange} />
                <button
                  type="button"
                  onClick={() => {
                    setMarketplaceMounted(true)
                    setMarketplaceOpen(true)
                  }}
                  data-testid="open-marketplace"
                  className="marketplace-browse-btn flex cursor-pointer items-center gap-2 self-start rounded-lg border px-3 py-2 text-xs font-semibold text-sec outline-none transition-all duration-200 hover:text-pri hover:-translate-y-0.5 active:scale-98 shadow-sm hover:shadow-md"
                  style={{
                    background: 'linear-gradient(to bottom, var(--bg-1), var(--bg-0))',
                    borderColor: 'var(--border-bright)',
                    ['--tw-ring-color' as string]:
                      'color-mix(in oklab, var(--accent) 45%, transparent)',
                  }}
                >
                  <Store size={14} aria-hidden className="text-accent" />
                  <span>{t('marketplace.openFromAddWorker')}</span>
                </button>
                {workerRole === 'custom' ? (
                  <RoleTemplatePicker
                    customTemplates={customTemplates}
                    onDeleteTemplate={onDeleteTemplate}
                    onSelect={onTemplateChange}
                    selectedTemplateId={selectedTemplateId}
                    {...(writeDisabledReason ? { disabledReason: writeDisabledReason } : {})}
                  />
                ) : null}
                <RoleInstructionsField
                  canSaveAsTemplate={
                    workerRole === 'custom' &&
                    !selectedTemplateId &&
                    roleDescription.trim().length > 0
                  }
                  modified={roleDescriptionModified}
                  onChange={onRoleDescriptionChange}
                  onReset={onRoleDescriptionReset}
                  onSaveAsTemplate={onSaveAsTemplate}
                  roleDescription={roleDescription}
                  templateBusy={templateBusy}
                  workerRole={workerRole}
                  {...(writeDisabledReason ? { writeDisabledReason } : {})}
                />
                <WorkerAvatarPicker
                  avatar={avatar}
                  commandPresetId={commandPresetId || undefined}
                  disabled={Boolean(writeDisabledReason)}
                  onChange={onAvatarChange}
                  workerRole={workerRole}
                  showStatus
                />
                <AgentCliPicker
                  commandPresetId={commandPresetId}
                  commandPresets={commandPresets}
                  onPresetChange={onPresetChange}
                />
                <StartupCommandField value={startupCommand} onChange={onStartupCommandChange} />
              </div>

              <div
                className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3 max-md:px-4 max-md:pb-[max(12px,env(safe-area-inset-bottom))]"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  className={`icon-btn border border-bright/20 rounded-lg hover:bg-3 hover:text-pri transition-all active:scale-95 ${isMobile ? 'flex-1' : ''}`}
                  data-testid="add-worker-cancel"
                >
                  {t('addWorker.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating || Boolean(writeDisabledReason)}
                  title={writeDisabledReason ?? undefined}
                  className={`icon-btn icon-btn--primary rounded-lg font-bold shadow-md hover:shadow-lg transition-all active:scale-[0.97] hover:-translate-y-0.5 ${isMobile ? 'flex-[2]' : ''}`}
                  data-testid="add-worker-submit"
                >
                  {creating ? t('addWorker.creating') : t('addWorker.create')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
      {marketplaceMounted ? (
        <Suspense fallback={null}>
          <MarketplaceDrawer
            open={marketplaceOpen}
            onClose={() => setMarketplaceOpen(false)}
            onImport={handleMarketplaceImport}
            importedNames={importedNames}
          />
        </Suspense>
      ) : null}
    </Dialog.Root>
  )
}
