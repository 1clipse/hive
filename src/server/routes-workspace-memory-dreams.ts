import { BadRequestError, ConflictError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import { serializeDreamRun } from './team-memory-dream-http-serializers.js'
import {
  DreamRunAlreadyRunningError,
  DreamRunNotFoundError,
  DreamRunRevertDataError,
  DreamRunRevertStatusError,
  DreamWorkspaceMissingError,
} from './team-memory-dream-store.js'
import {
  readWorkspaceMemoryDreamEnabled,
  readWorkspaceMemoryEnabled,
  workspaceMemoryDreamEnabledKey,
  workspaceMemoryEnabledKey,
} from './team-memory-feature.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const DREAM_RUN_LIST_MAX_LIMIT = 50

const requireWorkspace = (
  response: Parameters<typeof sendJson>[0],
  store: RuntimeStore,
  workspaceId: string
) => {
  if (store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) return true
  sendJson(response, 404, { error: `Workspace not found: ${workspaceId}` })
  return false
}

const requireDreamEnabled = (store: RuntimeStore, workspaceId: string) => {
  const memoryEnabled = readWorkspaceMemoryEnabled(
    store.settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value
  )
  const dreamEnabled = readWorkspaceMemoryDreamEnabled(
    store.settings.getAppState(workspaceMemoryDreamEnabledKey(workspaceId))?.value
  )
  if (!memoryEnabled) throw new ConflictError('Workspace memory is disabled')
  if (!dreamEnabled) throw new ConflictError('Workspace memory dream is disabled')
}

const hasRequestBody = (request: Parameters<RouteDefinition['handler']>[0]['request']) => {
  const rawContentLength = request.headers['content-length']
  const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
  return contentLength !== undefined && Number(contentLength) > 0
}

const parseLimit = (value: string | null) => {
  if (value === null) return 20
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BadRequestError('limit must be a non-negative integer')
  }
  return Math.min(Number(value), DREAM_RUN_LIST_MAX_LIMIT)
}

export const workspaceMemoryDreamRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory/dream-runs',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const runs = store.listMemoryDreamRuns(workspaceId, parseLimit(url.searchParams.get('limit')))
      sendJson(response, 200, { ok: true, runs: runs.map(serializeDreamRun) })
    }
  ),

  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/memory/dream-runs',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      requireDreamEnabled(store, workspaceId)
      if (hasRequestBody(request)) await readJsonBody<Record<string, never>>(request)
      try {
        const run = await store.runMemoryDream(workspaceId)
        if (run.status === 'failed') {
          sendJson(response, 409, {
            error: run.error ?? 'Dream run failed before it could be applied',
            ok: false,
            run: serializeDreamRun(run),
          })
          return
        }
        sendJson(response, 200, { ok: true, run: serializeDreamRun(run) })
      } catch (error) {
        if (error instanceof DreamRunAlreadyRunningError) {
          sendJson(response, 409, { error: 'Workspace already has a running dream run' })
          return
        }
        if (error instanceof DreamWorkspaceMissingError) {
          sendJson(response, 404, { error: `Workspace not found: ${error.workspaceId}` })
          return
        }
        throw error
      }
    }
  ),

  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/memory/dream-runs/:runId/revert',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      const runId = getRequiredParam(response, params, 'runId', 'Missing runId')
      if (!workspaceId || !runId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      if (hasRequestBody(request)) await readJsonBody<Record<string, never>>(request)
      try {
        const run = store.revertMemoryDream(workspaceId, runId)
        sendJson(response, 200, { ok: true, run: serializeDreamRun(run) })
      } catch (error) {
        if (error instanceof DreamRunNotFoundError) {
          sendJson(response, 404, { error: `Dream run not found: ${error.runId}` })
          return
        }
        if (error instanceof DreamRunRevertDataError) {
          sendJson(response, 409, { error: 'Dream run cannot be reverted from stored data' })
          return
        }
        if (error instanceof DreamRunRevertStatusError) {
          sendJson(response, 409, {
            error: `Dream run has status ${error.actualStatus}; expected ${error.expectedStatus}`,
          })
          return
        }
        throw error
      }
    }
  ),
]
