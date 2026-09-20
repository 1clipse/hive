import type { IncomingMessage } from 'node:http'

import { isWorkerRole } from '../shared/types.js'
import { normalizeWorkerAvatar } from '../shared/worker-avatar.js'
import {
  resolveCommandPresetLaunchConfig,
  resolveStartupCommandLaunchConfig,
} from './agent-launch-resolver.js'
import { BadRequestError } from './http-errors.js'
import { autostartAgent } from './orchestrator-autostart.js'
import { getDefaultRoleDescription } from './role-templates.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { CreateWorkerBody, RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { resolveWorkspaceUiLanguage } from './workspace-ui-language.js'

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

const readWorkerAvatar = (value: unknown) => {
  try {
    return normalizeWorkerAvatar(value)
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : String(error))
  }
}

const getSerializedWorker = (workspaceId: string, workerId: string, store: RuntimeStore) => {
  const worker = store.listWorkers(workspaceId).find((item) => item.id === workerId)
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`)
  }
  const [enriched] = enrichTeamList(workspaceId, store, [worker])
  if (!enriched) throw new Error(`Worker enrichment failed: ${workerId}`)
  return serializeTeamListItem(enriched, undefined, { includeAvatar: true })
}

export const workerRoutes: RouteDefinition[] = [
  route(
    'POST',
    '/api/workspaces/:workspaceId/workers',
    async ({ params, request, response, store }) => {
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

      const body = await readJsonBody<CreateWorkerBody>(request)
      if (!isWorkerRole(body.role)) {
        sendJson(response, 400, { error: 'Invalid worker role' })
        return
      }
      const avatar = Object.hasOwn(body, 'avatar') ? readWorkerAvatar(body.avatar) : null
      const presetId = body.command_preset_id ?? null
      const startupCommand = typeof body.startup_command === 'string' ? body.startup_command : null
      const language = resolveWorkspaceUiLanguage(store.settings, workspaceId, body.ui_language)
      const launchConfig = startupCommand?.trim()
        ? resolveStartupCommandLaunchConfig(store.settings, startupCommand, presetId)
        : presetId
          ? resolveCommandPresetLaunchConfig(store.settings, presetId)
          : undefined
      if (presetId && !startupCommand?.trim() && !launchConfig) {
        throw new Error(`Command preset not found: ${presetId}`)
      }
      const worker = store.addWorker(workspaceId, {
        ...body,
        role: body.role,
        avatar,
        description:
          typeof body.description === 'string'
            ? body.description
            : getDefaultRoleDescription(body.role, language),
      })
      if (launchConfig) {
        try {
          store.configureAgentLaunch(workspaceId, worker.id, launchConfig)
        } catch (error) {
          store.deleteWorker(workspaceId, worker.id)
          throw error
        }
      }

      const agentStart =
        body.autostart === true
          ? await autostartAgent(store, workspaceId, worker.id, getRuntimePort(request), {
              missingConfigError: 'No worker launch config available',
            })
          : { ok: false, error: null, run_id: null }

      sendJson(response, 201, {
        ...getSerializedWorker(workspaceId, worker.id, store),
        agent_start: agentStart,
      })
    }
  ),
  route(
    'DELETE',
    '/api/workspaces/:workspaceId/workers/:workerId',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      store.deleteWorker(workspaceId, workerId)
      response.statusCode = 204
      response.end()
    }
  ),
  route(
    'PATCH',
    '/api/workspaces/:workspaceId/workers/:workerId',
    async ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id and worker id are required'
      )
      const workerId = getRequiredParam(
        response,
        params,
        'workerId',
        'Workspace id and worker id are required'
      )
      if (!workspaceId || !workerId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const body = await readJsonBody<{ avatar?: unknown; name?: unknown }>(request)
      const hasName = Object.hasOwn(body, 'name')
      const hasAvatar = Object.hasOwn(body, 'avatar')
      if (!hasName && !hasAvatar) {
        sendJson(response, 400, { error: 'name or avatar is required' })
        return
      }
      if (hasName && typeof body.name !== 'string') {
        sendJson(response, 400, { error: 'name must be a string' })
        return
      }

      const avatar = hasAvatar ? readWorkerAvatar(body.avatar) : undefined
      store.updateWorkerProfile(workspaceId, workerId, {
        ...(hasName ? { name: body.name as string } : {}),
        ...(hasAvatar ? { avatar: avatar ?? null } : {}),
      })
      sendJson(response, 200, getSerializedWorker(workspaceId, workerId, store))
    }
  ),
]
