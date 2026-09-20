import { useLayoutMode } from '../mobile/layout-mode.js'
import { AddWorkspaceDialog } from './AddWorkspaceDialog.js'
import { ServerBrowseAddWorkspace } from './ServerBrowseAddWorkspace.js'
import type { WorkspaceCreateInput } from './workspace-create-input.js'

export interface AddWorkspaceFlowProps {
  trigger: number
  onClose: () => void
  onCreate: (input: WorkspaceCreateInput) => Promise<unknown> | undefined
  /** Demo-mode escape hatch shown when no built-in CLI is installed (P0-B1). */
  onTryDemo?: () => void
}

/**
 * Selects the add-workspace surface by LAYOUT, not transport: a narrow viewport (phone, or a narrow
 * self-hosted desktop window) gets the server-side browse/probe/manual-path flow that never pops an OS
 * dialog on the host; a wide viewport gets the byte-identical desktop AddWorkspaceDialog (OS picker).
 */
export const AddWorkspaceFlow = ({
  trigger,
  onClose,
  onCreate,
  onTryDemo,
}: AddWorkspaceFlowProps) => {
  const { mode } = useLayoutMode()
  if (mode === 'mobile') {
    return <ServerBrowseAddWorkspace trigger={trigger} onClose={onClose} onCreate={onCreate} />
  }
  return (
    <AddWorkspaceDialog
      trigger={trigger}
      onClose={onClose}
      onCreate={onCreate}
      {...(onTryDemo ? { onTryDemo } : {})}
    />
  )
}
