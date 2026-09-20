import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { WorkspaceAvatar } from '../sidebar/WorkspaceAvatar.js'
import { Confirm } from '../ui/Confirm.js'
import { useToast } from '../ui/useToast.js'

export interface MobileWorkspaceSwitcherProps {
  activeWorkspaceId: string | null
  workspaces: WorkspaceSummary[] | null
  workersByWorkspaceId: Record<string, TeamListItem[]>
  createDisabledReason?: string | undefined
  onSelectWorkspace: (workspaceId: string) => void
  onCreateClick: () => void
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void | Promise<void>
}

const workerSummary = (
  workers: TeamListItem[] | undefined,
  t: ReturnType<typeof useI18n>['t']
): string => {
  if (!workers || workers.length === 0) return t('sidebar.noMembers')
  const working = workers.filter((worker) => worker.status === 'working').length
  if (working > 0) return t('sidebar.workingCount', { working, total: workers.length })
  return t('sidebar.teamMemberCount', { count: workers.length })
}

/**
 * Mobile workspace switch. The topbar's active-workspace name is the trigger;
 * tapping it raises a bottom sheet with one big row per workspace (avatar,
 * name, member summary, active check, delete) and a New-workspace footer.
 * Purpose-built for touch — the desktop Sidebar's dense rows, collapse rail
 * and hover affordances never fit a phone.
 */
export const MobileWorkspaceSwitcher = ({
  activeWorkspaceId,
  workspaces,
  workersByWorkspaceId,
  createDisabledReason,
  onSelectWorkspace,
  onCreateClick,
  onDeleteWorkspace,
}: MobileWorkspaceSwitcherProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const activeName =
    workspaces?.find((workspace) => workspace.id === activeWorkspaceId)?.name ??
    t('mobile.section.workspaces')

  const confirmDelete = () => {
    if (!pendingDelete || deleting) return
    const workspace = pendingDelete
    setDeleting(true)
    void Promise.resolve(onDeleteWorkspace(workspace))
      .then(() => {
        toast.show({ kind: 'success', message: t('sidebar.removed', { name: workspace.name }) })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.show({ kind: 'error', message: t('sidebar.deleteFailed', { message }) })
      })
      .finally(() => {
        setDeleting(false)
        setPendingDelete(null)
      })
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          data-testid="mobile-workspace-switcher-trigger"
          aria-label={t('mobile.workspaces.switch')}
          className="mobile-ws-switcher flex min-h-11 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-pri">{activeName}</span>
          <ChevronDown size={16} aria-hidden className="shrink-0 text-ter" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="mobile-workspace-switcher-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid items-end">
          <Dialog.Content
            data-testid="mobile-workspace-switcher-sheet"
            className="dialog-slide-up elev-2 pointer-events-auto flex max-h-[70dvh] w-full flex-col overflow-hidden rounded-t-xl border-t"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <Dialog.Title asChild>
              <div
                className="flex shrink-0 items-baseline gap-2 border-b px-4 py-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="text-base font-semibold text-pri">{t('sidebar.workspaces')}</span>
                {workspaces && workspaces.length > 0 ? (
                  <span className="text-xs text-ter tabular-nums">{workspaces.length}</span>
                ) : null}
              </div>
            </Dialog.Title>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {!workspaces || workspaces.length === 0 ? (
                <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
                  <span className="text-sm font-medium text-sec">{t('sidebar.noWorkspaces')}</span>
                  <span className="text-xs text-ter">
                    {createDisabledReason ?? t('sidebar.noWorkspacesDesc')}
                  </span>
                </div>
              ) : (
                workspaces.map((workspace) => {
                  const isActive = workspace.id === activeWorkspaceId
                  const workers = workersByWorkspaceId[workspace.id]
                  const workingCount =
                    workers?.filter((worker) => worker.status === 'working').length ?? 0
                  return (
                    <div key={workspace.id} className="flex items-center gap-1 pr-2">
                      <button
                        type="button"
                        data-testid={`mobile-ws-row-${workspace.id}`}
                        onClick={() => {
                          setOpen(false)
                          onSelectWorkspace(workspace.id)
                        }}
                        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left"
                        style={
                          isActive
                            ? {
                                background: 'color-mix(in oklab, var(--accent) 10%, transparent)',
                              }
                            : undefined
                        }
                      >
                        <WorkspaceAvatar
                          workspaceId={workspace.id}
                          name={workspace.name}
                          isActive={isActive}
                          working={workingCount > 0}
                          workingCount={workingCount}
                          size={36}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium text-pri">
                            {workspace.name}
                          </span>
                          <span className="truncate text-xs text-ter">
                            {workerSummary(workers, t)}
                          </span>
                        </span>
                        {isActive ? (
                          <Check size={18} className="shrink-0 text-accent" aria-hidden />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        aria-label={t('sidebar.deleteAria', { name: workspace.name })}
                        data-testid={`mobile-ws-delete-${workspace.id}`}
                        onClick={() => setPendingDelete(workspace)}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ter"
                      >
                        <Trash2 size={16} aria-hidden />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
            <div
              className="shrink-0 border-t px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
            >
              <button
                type="button"
                disabled={Boolean(createDisabledReason)}
                title={createDisabledReason}
                data-testid="mobile-ws-create"
                onClick={() => {
                  setOpen(false)
                  onCreateClick()
                }}
                className="icon-btn icon-btn--primary flex w-full min-h-11 items-center justify-center gap-1.5"
              >
                <Plus size={16} aria-hidden />
                {t('sidebar.newWorkspace')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
      <Confirm
        open={pendingDelete !== null}
        onOpenChange={(value) => {
          if (!value && !deleting) setPendingDelete(null)
        }}
        title={
          pendingDelete
            ? t('sidebar.deleteConfirm', { name: pendingDelete.name })
            : t('sidebar.deleteLabel')
        }
        description={
          pendingDelete
            ? t('sidebar.deleteDescription', {
                path: pendingDelete.path,
                summary: workerSummary(workersByWorkspaceId[pendingDelete.id], t),
              })
            : ''
        }
        confirmLabel={deleting ? t('sidebar.deleting') : t('sidebar.deleteLabel')}
        confirmKind="danger"
        onConfirm={confirmDelete}
      />
    </Dialog.Root>
  )
}
