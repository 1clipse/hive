import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { computeRunnableTasks } from './task-deps.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const taskRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks/next',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      // CLI-agent auth (mirrors `team list`): `team next` is an orchestrator
      // planning query, not a UI call.
      const agentId = request.headers['x-hive-agent-id']
      const token = request.headers['x-hive-agent-token']
      const agent = authenticateCliAgent({
        fromAgentId: typeof agentId === 'string' ? agentId : undefined,
        getAgent: store.getAgent,
        token: typeof token === 'string' ? token : undefined,
        validateToken: store.validateAgentToken,
        workspaceId,
      })
      requireCommandForRole(agent, 'next')

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const tasks = computeRunnableTasks(tasksFileService.readTasks(workspace.summary.path))
      sendJson(response, 200, { tasks })
    }
  ),
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      sendJson(response, 200, { content: tasksFileService.readTasks(workspace.summary.path) })
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)

      const body = await readJsonBody<{ content: string }>(request)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      tasksFileService.writeTasks(workspace.summary.path, body.content)
      sendJson(response, 200, { content: body.content })
    }
  ),
]
