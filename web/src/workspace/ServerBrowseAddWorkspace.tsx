import { useEffect, useRef, useState } from 'react'

import { useI18n } from '../i18n.js'
import { ServerBrowseDialog } from './ServerBrowseDialog.js'
import { useCommandPresets } from './useCommandPresets.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

export interface ServerBrowseAddWorkspaceProps {
  /** `0` = closed; any positive bump = open a new flow (mirrors AddWorkspaceDialog's trigger). */
  trigger: number
  onClose: () => void
  onCreate: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
}

/**
 * The MOBILE add-workspace surface. Where the desktop AddWorkspaceDialog fires the OS folder picker
 * (`pickFolder()` → a native dialog on the HOST machine), this routes entirely through the server-side
 * browse + probe + manual-path surface — it NEVER touches `/api/fs/pick-folder`. The manual-path field
 * is expanded by default because a phone user has no OS picker to fall back to.
 */
export const ServerBrowseAddWorkspace = ({
  trigger,
  onClose,
  onCreate,
}: ServerBrowseAddWorkspaceProps) => {
  const { t } = useI18n()
  // Open while the latest trigger is unconsumed. We track which trigger value we opened for so a
  // create/close consumes it without re-opening on the next render.
  const [open, setOpen] = useState(false)
  const consumedTriggerRef = useRef(0)

  useEffect(() => {
    if (trigger > 0 && trigger !== consumedTriggerRef.current) {
      setOpen(true)
    }
  }, [trigger])

  const presets = useCommandPresets(open)

  const close = () => {
    consumedTriggerRef.current = trigger
    setOpen(false)
    onClose()
  }

  const handleCreate = (input: WorkspaceCreateInput) => {
    void Promise.resolve(onCreate(input)).then(() => {
      consumedTriggerRef.current = trigger
      setOpen(false)
    })
  }

  if (!open) return null

  return (
    <ServerBrowseDialog
      open
      initialAdvanced
      manualHint={t('workspace.add.manualHint')}
      commandPresetError={presets.commandPresetError}
      commandPresetId={presets.commandPresetId}
      commandPresets={presets.commandPresets}
      onClose={close}
      onCommandPresetChange={presets.onCommandPresetChange}
      onCreate={handleCreate}
    />
  )
}
