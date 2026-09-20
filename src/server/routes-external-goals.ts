import { HIVE_SUPERVISOR_TOKEN_HEADER } from './external-goal-auth.js'
import { ExternalGoalDeliveryError } from './external-goal-bridge.js'
import { BadRequestError, ForbiddenError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  ExternalGoalCancelBody,
  ExternalGoalContinueBody,
  ExternalGoalStartBody,
  ExternalGoalWaitBody,
  RouteDefinition,
} from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'

const BODY_MAX_CHARS = 40_000
const SOURCE_MAX_CHARS = 80

type ExternalGoalEvent = Awaited<ReturnType<RuntimeStore['waitExternalGoal']>>['events'][number]
type ExternalGoalSession = Awaited<ReturnType<RuntimeStore['startExternalGoal']>>['session']

const requireNonEmptyString = (value: unknown, field: string, maxChars = BODY_MAX_CHARS) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  if ([...value].length > maxChars) {
    throw new BadRequestError(`${field} must be ${maxChars} characters or fewer`)
  }
  return value
}

const optionalNonEmptyString = (value: unknown, field: string, maxChars = SOURCE_MAX_CHARS) => {
  if (value === undefined || value === null) return undefined
  return requireNonEmptyString(value, field, maxChars)
}

const serializeEvent = (event: ExternalGoalEvent) => ({
  artifacts: event.artifacts,
  body: event.body,
  created_at: event.createdAt,
  goal_id: event.goalId,
  id: event.id,
  kind: event.kind,
  sequence: event.sequence,
  status: event.status,
  workspace_id: event.workspaceId,
})

const serializeSession = (session: ExternalGoalSession) => ({
  closed_at: session.closedAt,
  created_at: session.createdAt,
  goal: session.goal,
  id: session.id,
  source: session.source,
  status: session.status,
  summary: session.summary,
  title: session.title,
  updated_at: session.updatedAt,
  workspace_id: session.workspaceId,
})

const serializeWaitResult = (result: Awaited<ReturnType<RuntimeStore['waitExternalGoal']>>) => ({
  cursor: result.cursor,
  events: result.events.map(serializeEvent),
  goal_id: result.goalId,
  status: result.status,
})

const sendDeliveryError = (
  response: Parameters<RouteDefinition['handler']>[0]['response'],
  error: ExternalGoalDeliveryError
) => {
  sendJson(response, error.statusCode, {
    cursor: error.cursor,
    error: error.message,
    goal_id: error.goalId,
    status: error.status,
  })
}

const requireExternalController = (
  store: RuntimeStore,
  request: Parameters<RouteDefinition['handler']>[0]['request']
) => {
  if (store.authorizeRemoteTunnelRequest(request)) {
    throw new ForbiddenError('Supervisor token is not available over the remote tunnel')
  }
  const rawToken = request.headers[HIVE_SUPERVISOR_TOKEN_HEADER]
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
  if (!store.validateSupervisorToken(token)) {
    throw new ForbiddenError('External goal endpoint requires valid Supervisor token')
  }
}

export const externalGoalRoutes: RouteDefinition[] = [
  route('GET', '/api/external-goals/session', ({ request, response, store }) => {
    if (store.authorizeRemoteTunnelRequest(request)) {
      throw new ForbiddenError('Supervisor token is not available over the remote tunnel')
    }
    sendJson(response, 200, {
      token: store.getSupervisorToken(),
      token_type: 'hive-supervisor',
    })
  }),
  route('GET', '/api/external-goals/workspaces', ({ request, response, store }) => {
    requireExternalController(store, request)
    sendJson(response, 200, { workspaces: store.listExternalGoalWorkspaces() })
  }),
  route(
    'GET',
    '/api/external-goals/workspaces/:workspaceId',
    ({ params, request, response, store }) => {
      requireExternalController(store, request)
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return
      sendJson(response, 200, store.inspectExternalGoalWorkspace({ workspaceId }))
    }
  ),
  route('POST', '/api/external-goals/start', async ({ request, response, store }) => {
    requireExternalController(store, request)
    const body = await readJsonBody<ExternalGoalStartBody>(request)
    const workspaceId = requireNonEmptyString(body.workspace_id, 'workspace_id', 200)
    const goal = requireNonEmptyString(body.goal, 'goal')
    const source = optionalNonEmptyString(body.source, 'source') ?? 'hive-mcp'
    let result: Awaited<ReturnType<RuntimeStore['startExternalGoal']>>
    try {
      result = await store.startExternalGoal({
        workspaceId,
        goal,
        source,
        ...(body.context !== undefined ? { context: body.context } : {}),
        ...(body.timeout_hint_ms !== undefined ? { timeoutHintMs: body.timeout_hint_ms } : {}),
      })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
    sendJson(response, 202, {
      cursor: result.cursor,
      events: result.events.map(serializeEvent),
      goal_id: result.goalId,
      ok: true,
      session: serializeSession(result.session),
      status: result.status,
    })
  }),
  route('POST', '/api/external-goals/wait', async ({ request, response, store }) => {
    requireExternalController(store, request)
    const body = await readJsonBody<ExternalGoalWaitBody>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const result = await store.waitExternalGoal({
      goalId,
      ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
      ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}),
    })
    sendJson(response, 200, serializeWaitResult(result))
  }),
  route('POST', '/api/external-goals/continue', async ({ request, response, store }) => {
    requireExternalController(store, request)
    const body = await readJsonBody<ExternalGoalContinueBody>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const message = requireNonEmptyString(body.message, 'message')
    let result: Awaited<ReturnType<RuntimeStore['continueExternalGoal']>>
    try {
      result = await store.continueExternalGoal({
        goalId,
        message,
        ...(body.context !== undefined ? { context: body.context } : {}),
      })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
    sendJson(response, 202, {
      cursor: result.cursor,
      event: serializeEvent(result.event),
      ok: true,
      session: serializeSession(result.session),
      status: result.status,
    })
  }),
  route('POST', '/api/external-goals/cancel', async ({ request, response, store }) => {
    requireExternalController(store, request)
    const body = await readJsonBody<ExternalGoalCancelBody>(request)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const reason = requireNonEmptyString(body.reason, 'reason')
    let result: Awaited<ReturnType<RuntimeStore['cancelExternalGoal']>>
    try {
      result = await store.cancelExternalGoal({ goalId, reason })
    } catch (error) {
      if (error instanceof ExternalGoalDeliveryError) {
        sendDeliveryError(response, error)
        return
      }
      throw error
    }
    sendJson(response, 202, {
      cursor: result.cursor,
      event: serializeEvent(result.event),
      ok: true,
      session: serializeSession(result.session),
      status: result.status,
    })
  }),
]
