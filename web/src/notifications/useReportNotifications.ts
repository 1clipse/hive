import { useEffect, useRef } from 'react'
import type { TeamListItem, WorkspaceSummary } from '../../../src/shared/types.js'
import { getReportedDispatches } from '../api.js'
import { useI18n } from '../i18n.js'
import { useNotifications } from './NotificationProvider.js'

/** Report notifications follow committed ledger facts, including old tasks that
 * finish late. The overlapping timestamp boundary retains IDs for same-ms reports. */
export const useReportNotifications = (
  workspace: WorkspaceSummary | undefined,
  workers: TeamListItem[]
) => {
  const { notify } = useNotifications()
  const { t } = useI18n()
  const names = useRef({ workspaceName: workspace?.name ?? '', workers })
  const cursor = useRef<{
    workspaceId: string
    since: number | null
    seen: Map<string, number>
  } | null>(null)
  const workspaceId = workspace?.id
  useEffect(() => {
    names.current = { workspaceName: workspace?.name ?? '', workers }
  }, [workspace?.name, workers])

  useEffect(() => {
    if (!workspaceId) {
      cursor.current = null
      return
    }
    if (cursor.current?.workspaceId !== workspaceId)
      cursor.current = { workspaceId, since: null, seen: new Map() }
    const state = cursor.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        if (state.since === null) {
          // Establish a server-clock snapshot without replaying old reports.
          const snapshot = await getReportedDispatches(workspaceId, null, 0, controller.signal)
          if (controller.signal.aborted) return
          let latest = snapshot.snapshotMs
          let offset = 0
          for (;;) {
            const boundary = await getReportedDispatches(
              workspaceId,
              snapshot.snapshotMs,
              offset,
              controller.signal
            )
            if (controller.signal.aborted) return
            for (const report of boundary.reports) {
              latest = Math.max(latest, report.reported_at)
              state.seen.set(report.id, report.reported_at)
            }
            if (boundary.reports.length < 100) break
            offset += boundary.reports.length
          }
          state.since = latest
        } else {
          const since = state.since
          let latest = since
          let offset = 0
          for (;;) {
            const page = await getReportedDispatches(workspaceId, since, offset, controller.signal)
            if (controller.signal.aborted) return
            for (const report of page.reports) {
              latest = Math.max(latest, report.reported_at)
              if (state.seen.has(report.id)) continue
              state.seen.set(report.id, report.reported_at)
              const name =
                names.current.workers.find((worker) => worker.id === report.to_agent_id)?.name ??
                t('actionCenter.unknownWorker')
              notify({
                brief: t('notifications.workerReported.brief', { name }),
                detail: t('notifications.workerReported.detail', {
                  name,
                  workspace: names.current.workspaceName,
                }),
                kind: 'success',
                title: t('notifications.workerReported.title'),
              })
            }
            if (page.reports.length < 100) break
            offset += page.reports.length
          }
          state.since = latest
          for (const [id, at] of state.seen) if (at < latest) state.seen.delete(id)
        }
      } catch {
        // Connection status already surfaces transport failures. Keep the cursor
        // so the next successful read can deliver reports missed during the gap.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [workspaceId, notify, t])
}
