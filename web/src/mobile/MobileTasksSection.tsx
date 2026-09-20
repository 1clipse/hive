import { lazy, Suspense, useMemo } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { useI18n } from '../i18n.js'
import { logSwallowed } from '../lib/log-swallowed.js'
import type { useTasksFile } from '../tasks/useTasksFile.js'
import { EmptyState } from '../ui/EmptyState.js'

type TasksFileApi = ReturnType<typeof useTasksFile>

const EMPTY_WORKERS: readonly TeamListItem[] = []

const TaskGraphContent = lazy(() =>
  import('../tasks/TaskGraphDrawer.js').then((module) => ({
    default: module.TaskGraphContent,
  }))
)

export interface MobileTasksSectionProps {
  tasksFile: TasksFileApi
  workspacePath: string | null
  workers?: readonly TeamListItem[]
  onSelectOwner?: (workerName: string) => void
  onAddWorkspace?: () => void
  demoMode?: boolean
}

/**
 * The Tasks bottom-nav section. Renders TaskGraphContent directly — no Dialog
 * wrapper, no overlay, no focus trap. The bottom nav is the navigation.
 */
export const MobileTasksSection = ({
  tasksFile,
  workspacePath,
  workers,
  onSelectOwner,
  onAddWorkspace,
  demoMode = false,
}: MobileTasksSectionProps) => {
  const { t } = useI18n()
  const stableWorkers = workers ?? EMPTY_WORKERS
  const knownWorkerNames = useMemo(
    () => (stableWorkers.length ? stableWorkers.map((w) => w.name) : undefined),
    [stableWorkers]
  )
  if (!workspacePath) {
    return (
      <div className="flex h-full flex-col" data-testid="mobile-tasks-empty">
        <EmptyState
          title={t('mobile.tasks.noWorkspaceTitle')}
          description={t('mobile.tasks.noWorkspaceDesc')}
          action={
            onAddWorkspace ? (
              <button
                type="button"
                onClick={onAddWorkspace}
                className="icon-btn icon-btn--primary mt-1 flex min-h-11 items-center gap-1.5 px-4 py-2 text-xs font-medium"
              >
                {t('firstRun.addWorkspace')}
              </button>
            ) : undefined
          }
        />
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {demoMode ? (
        <div className="flex shrink-0 items-center justify-end px-3 py-1">
          <span className="pill pill--neutral text-xs">{t('demo.readOnlyBadge')}</span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <TaskGraphContent
            content={tasksFile.content}
            hasConflict={tasksFile.hasConflict}
            onContentChange={tasksFile.onChange}
            onKeepLocal={tasksFile.onKeepLocal}
            onReload={tasksFile.onReload}
            onSave={tasksFile.onSave}
            onToggleTaskLine={(line) => {
              void tasksFile.toggleTaskAtLine(line).catch(logSwallowed('tasks.toggleTaskAtLine'))
            }}
            onAppendTask={(text) => {
              void tasksFile.appendTask(text).catch(logSwallowed('tasks.appendTask'))
            }}
            onAppendSubtask={(parentLine, text) => {
              void tasksFile
                .appendSubtask(parentLine, text)
                .catch(logSwallowed('tasks.appendSubtask'))
            }}
            onUpdateTaskText={(line, nextText) => {
              void tasksFile
                .updateTaskText(line, nextText)
                .catch(logSwallowed('tasks.updateTaskText'))
            }}
            onDeleteTask={(line) => {
              void tasksFile.deleteTask(line).catch(logSwallowed('tasks.deleteTask'))
            }}
            workspacePath={workspacePath}
            {...(knownWorkerNames ? { knownWorkerNames } : {})}
            {...(onSelectOwner ? { onSelectOwner } : {})}
          />
        </Suspense>
      </div>
    </div>
  )
}
