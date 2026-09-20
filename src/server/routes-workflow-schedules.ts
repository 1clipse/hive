import { validateCronNextRunAt } from './cron-util.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeWorkflowSchedule } from './workflow-http-serializers.js'

interface UpdateScheduleBody {
  cron?: unknown
  args?: unknown
  enabled?: unknown
}

// Schedules are CREATED by the orchestrator agent (`team workflow schedule`),
// which persists the workflow source so cron can fire it with no orchestrator
// in the loop. The UI only LISTS / PAUSES / RESUMES / DELETES them — there is
// no human create route here.
export const workflowScheduleRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/workflow-schedules',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      sendJson(response, 200, {
        schedules: store.listWorkspaceWorkflowSchedules(workspaceId).map(serializeWorkflowSchedule),
      })
    }
  ),
  route(
    'PATCH',
    '/api/workflow-schedules/:scheduleId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const scheduleId = getRequiredParam(response, params, 'scheduleId', 'Missing scheduleId')
      if (!scheduleId) return
      const existing = store.getWorkflowSchedule(scheduleId)
      if (!existing) {
        sendJson(response, 404, { error: `Schedule not found: ${scheduleId}` })
        return
      }
      const body = await readJsonBody<UpdateScheduleBody>(request)
      const update: Parameters<typeof store.updateWorkflowSchedule>[1] = {}
      if (typeof body.cron === 'string') {
        update.cron = body.cron
        update.nextRunAt = validateCronNextRunAt(body.cron)
      }
      if (body.args !== undefined) update.args = body.args
      if (typeof body.enabled === 'boolean') update.enabled = body.enabled
      store.updateWorkflowSchedule(scheduleId, update)
      const refreshed = store.getWorkflowSchedule(scheduleId)
      sendJson(response, 200, {
        schedule: refreshed ? serializeWorkflowSchedule(refreshed) : null,
      })
    }
  ),
  route('DELETE', '/api/workflow-schedules/:scheduleId', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const scheduleId = getRequiredParam(response, params, 'scheduleId', 'Missing scheduleId')
    if (!scheduleId) return
    const existing = store.getWorkflowSchedule(scheduleId)
    if (!existing) {
      sendJson(response, 404, { error: `Schedule not found: ${scheduleId}` })
      return
    }
    store.deleteWorkflowSchedule(scheduleId)
    sendJson(response, 200, { ok: true })
  }),
]
