import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControllerStatus } from '../shared/types.js'
import { type ControllerActionInput, controllerString } from './controller-actions.js'
import { HIVE_SUPERVISOR_TOKEN_HEADER } from './external-goal-auth.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const HIVE_CONTROLLER_THREAD_HEADER = 'x-hive-controller-thread-id'
const sendControllerStatus = (
  request: IncomingMessage,
  response: ServerResponse,
  status: ControllerStatus
) => sendJson(response, 200, { ...status, runtime_port: request.socket.localPort })
const readControllerBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const body = await readJsonBody<unknown>(request)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Expected a JSON object')
  return body as Record<string, unknown>
}

const requireControllerCaller = (request: IncomingMessage, store: RuntimeStore) => {
  if (store.authorizeRemoteTunnelRequest(request))
    throw new ForbiddenError('Codex App controllers are local-only')
  const token = request.headers[HIVE_SUPERVISOR_TOKEN_HEADER]
  if (typeof token !== 'string' || !store.validateSupervisorToken(token))
    throw new ForbiddenError('A local Supervisor token is required')
  const threadId = request.headers[HIVE_CONTROLLER_THREAD_HEADER]
  if (
    typeof threadId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
  )
    throw new BadRequestError('A Codex host thread ID is required')
  return threadId
}
const requireLocalUi = (request: IncomingMessage, store: RuntimeStore) => {
  if (store.authorizeRemoteTunnelRequest(request))
    throw new ForbiddenError('Confirm controller connections on the local Hive panel')
  requireUiTokenFromRequest(request, store.validateUiToken)
}
export const controllerRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/controller',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      sendControllerStatus(request, response, store.getControllerStatus(params.workspaceId ?? ''))
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/controller/confirm',
    async ({ params, request, response, store }) => {
      requireLocalUi(request, store)
      const body = await readControllerBody(request)
      if (Object.keys(body).some((key) => key !== 'request_id'))
        throw new BadRequestError('Only request_id is accepted')
      sendControllerStatus(
        request,
        response,
        await store.confirmController(
          params.workspaceId ?? '',
          controllerString(body, 'request_id')
        )
      )
    }
  ),
  route(
    'POST',
    '/api/workspaces/:workspaceId/controller/disconnect',
    async ({ params, request, response, store }) => {
      requireLocalUi(request, store)
      const body = await readControllerBody(request)
      if (Object.keys(body).length) throw new BadRequestError('Disconnect accepts an empty object')
      sendControllerStatus(request, response, store.disconnectController(params.workspaceId ?? ''))
    }
  ),
  route('POST', '/api/controller/request', async ({ request, response, store }) => {
    const threadId = requireControllerCaller(request, store)
    const body = await readControllerBody(request)
    if (Object.keys(body).some((key) => key !== 'workspace_id'))
      throw new BadRequestError('Only workspace_id is accepted')
    sendJson(
      response,
      202,
      store.requestController(controllerString(body, 'workspace_id'), threadId)
    )
  }),
  route('POST', '/api/controller/action', async ({ request, response, store }) => {
    const threadId = requireControllerCaller(request, store)
    const body = await readControllerBody(request)
    controllerString(body, 'workspace_id')
    controllerString(body, 'action')
    const result = await store.controllerAction(
      body as ControllerActionInput,
      threadId,
      String(request.socket.localPort ?? '')
    )
    sendJson(response, 200, result)
  }),
]
