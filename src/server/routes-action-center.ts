import { buildActionCenterSummary } from './action-center-summary.js'
import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { buildTeamRecapMarkdown } from './team-recap.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const RECAP_DISPATCH_LIMIT = 12

export const actionCenterRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/action-center',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
        sendJson(response, 404, { error: 'Workspace not found' })
        return
      }
      sendJson(response, 200, buildActionCenterSummary({ store, workspaceId }))
    }
  ),
  route('GET', '/api/workspaces/:workspaceId/recap', ({ params, request, response, store }) => {
    const workspaceId = getRequiredParam(
      response,
      params,
      'workspaceId',
      'Workspace id is required'
    )
    if (!workspaceId) return

    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const workspace = store.listWorkspaces().find((entry) => entry.id === workspaceId)
    if (!workspace) {
      sendJson(response, 404, { error: 'Workspace not found' })
      return
    }

    const now = Date.now()
    const markdown = buildTeamRecapMarkdown({
      dispatches: store.listRecentDispatches(workspaceId, RECAP_DISPATCH_LIMIT),
      now,
      workers: store.listWorkers(workspaceId),
      workspaceName: workspace.name,
    })
    sendJson(response, 200, { generated_at: now, markdown })
  }),
]
