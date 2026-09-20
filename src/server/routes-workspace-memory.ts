import {
  isMemoryScope,
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_SEARCH_MAX_LIMIT,
  type MemoryScope,
} from '../shared/team-memory.js'
import { BadRequestError } from './http-errors.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import type { RuntimeStore } from './runtime-store.js'
import {
  readWorkspaceMemoryDreamEnabled,
  readWorkspaceMemoryEnabled,
  serializeWorkspaceMemoryDreamEnabled,
  serializeWorkspaceMemoryEnabled,
  workspaceMemoryDreamEnabledKey,
  workspaceMemoryEnabledKey,
} from './team-memory-feature.js'
import { serializeMemoryEntry, serializeMemoryInjection } from './team-memory-http-serializers.js'
import {
  MemoryEntryNotFoundError,
  MemoryEntryStatusError,
  type MemoryStatus,
} from './team-memory-store.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const MEMORY_STATUSES: MemoryStatus[] = ['active', 'candidate', 'archived', 'rejected']

interface PatchMemoryBody {
  disabled?: unknown
  pinned?: unknown
}

interface UpdateMemorySettingsBody {
  dream_enabled?: unknown
  enabled?: unknown
}

const parseLimit = (value: string | null) => {
  if (value === null) return MEMORY_SEARCH_MAX_LIMIT
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BadRequestError('limit must be a non-negative integer')
  }
  return Math.min(Number(value), MEMORY_SEARCH_MAX_LIMIT)
}

const parseStatuses = (value: string | null): MemoryStatus[] => {
  if (value === null) return ['active']
  if (value === 'all') return MEMORY_STATUSES
  if (MEMORY_STATUSES.includes(value as MemoryStatus)) return [value as MemoryStatus]
  throw new BadRequestError('status must be active, candidate, archived, rejected, or all')
}

const parseQuery = (value: string | null) => {
  const query = value?.trim() ?? ''
  if ([...query].length > MEMORY_QUERY_MAX_CHARS) {
    throw new BadRequestError(`query must be ${MEMORY_QUERY_MAX_CHARS} characters or fewer`)
  }
  return query
}

const parseScopes = (value: string | null): MemoryScope[] => {
  if (value === null) return ['workspace']
  if (value === 'all') return ['workspace', 'user']
  if (isMemoryScope(value)) return [value]
  throw new BadRequestError('scope must be workspace, user, or all')
}

const requireBoolean = (value: unknown, field: string) => {
  if (typeof value !== 'boolean') throw new BadRequestError(`${field} must be a boolean`)
  return value
}

const sendMemoryMutationError = (response: Parameters<typeof sendJson>[0], error: unknown) => {
  if (error instanceof MemoryEntryNotFoundError) {
    sendJson(response, 404, { error: `Memory entry not found: ${error.memoryId}` })
    return true
  }
  if (error instanceof MemoryEntryStatusError) {
    sendJson(response, 409, {
      error: `Memory entry has status ${error.actualStatus}; expected ${
        Array.isArray(error.expectedStatus)
          ? error.expectedStatus.join(' or ')
          : error.expectedStatus
      }`,
    })
    return true
  }
  return false
}

const getMemoryId = (response: Parameters<typeof sendJson>[0], params: Record<string, string>) =>
  getRequiredParam(response, params, 'memoryId', 'Missing memoryId')

const requireWorkspace = (
  response: Parameters<typeof sendJson>[0],
  store: RuntimeStore,
  workspaceId: string
) => {
  if (store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) return true
  sendJson(response, 404, { error: `Workspace not found: ${workspaceId}` })
  return false
}

export const workspaceMemoryRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/workspaces/:workspaceId/memory', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
    if (!workspaceId) return
    if (!requireWorkspace(response, store, workspaceId)) return
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const statuses = parseStatuses(url.searchParams.get('status'))
    const limit = parseLimit(url.searchParams.get('limit'))
    const query = parseQuery(url.searchParams.get('query'))
    const scopes = parseScopes(url.searchParams.get('scope'))
    const memories = query
      ? store.searchMemoryEntries(workspaceId, query, {
          includeDisabled: true,
          limit,
          scopes,
          statuses,
        })
      : store.listMemoryEntries(workspaceId, { limit, scopes, statuses })
    sendJson(response, 200, { memories: memories.map(serializeMemoryEntry), ok: true })
  }),

  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory/injections',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const dispatchId = url.searchParams.get('dispatch_id')?.trim()
      if (!dispatchId) throw new BadRequestError('Missing dispatch_id')
      sendJson(response, 200, {
        injections: store
          .listMemoryInjectionsForDispatch(workspaceId, dispatchId)
          .map(serializeMemoryInjection),
        ok: true,
      })
    }
  ),

  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory/settings',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      sendJson(response, 200, {
        dream_enabled: readWorkspaceMemoryDreamEnabled(
          store.settings.getAppState(workspaceMemoryDreamEnabledKey(workspaceId))?.value
        ),
        enabled: readWorkspaceMemoryEnabled(
          store.settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value
        ),
        ok: true,
      })
    }
  ),

  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/memory/diagnostics',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      sendJson(response, 200, {
        diagnostics: store.getMemoryDiagnostics({
          query: parseQuery(url.searchParams.get('query')) || null,
          taskText: parseQuery(url.searchParams.get('task_text')) || null,
          workerDescription: parseQuery(url.searchParams.get('worker_description')) || null,
          workspaceId,
        }),
        ok: true,
      })
    }
  ),

  route(
    'PUT',
    '/api/ui/workspaces/:workspaceId/memory/settings',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      const body = await readJsonBody<UpdateMemorySettingsBody>(request)
      if (body.enabled !== undefined) {
        store.settings.setAppState(
          workspaceMemoryEnabledKey(workspaceId),
          serializeWorkspaceMemoryEnabled(requireBoolean(body.enabled, 'enabled'))
        )
      }
      if (body.dream_enabled !== undefined) {
        store.settings.setAppState(
          workspaceMemoryDreamEnabledKey(workspaceId),
          serializeWorkspaceMemoryDreamEnabled(requireBoolean(body.dream_enabled, 'dream_enabled'))
        )
      }
      sendJson(response, 200, {
        dream_enabled: readWorkspaceMemoryDreamEnabled(
          store.settings.getAppState(workspaceMemoryDreamEnabledKey(workspaceId))?.value
        ),
        enabled: readWorkspaceMemoryEnabled(
          store.settings.getAppState(workspaceMemoryEnabledKey(workspaceId))?.value
        ),
        ok: true,
      })
    }
  ),

  route(
    'PATCH',
    '/api/ui/workspaces/:workspaceId/memory/:memoryId',
    async ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      const memoryId = getMemoryId(response, params)
      if (!workspaceId || !memoryId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      const body = await readJsonBody<PatchMemoryBody>(request)
      try {
        let memory = store.getMemoryEntry(workspaceId, memoryId)
        if (!memory) throw new MemoryEntryNotFoundError(memoryId, workspaceId)
        if (body.pinned !== undefined) {
          memory = store.setMemoryPinned(
            workspaceId,
            memoryId,
            requireBoolean(body.pinned, 'pinned')
          )
        }
        if (body.disabled !== undefined) {
          memory = store.setMemoryDisabled(
            workspaceId,
            memoryId,
            requireBoolean(body.disabled, 'disabled')
          )
        }
        sendJson(response, 200, { memory: serializeMemoryEntry(memory), ok: true })
      } catch (error) {
        if (!sendMemoryMutationError(response, error)) throw error
      }
    }
  ),

  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/memory/:memoryId/approve',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      const memoryId = getMemoryId(response, params)
      if (!workspaceId || !memoryId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      try {
        sendJson(response, 200, {
          memory: serializeMemoryEntry(store.approveMemoryCandidate(workspaceId, memoryId)),
          ok: true,
        })
      } catch (error) {
        if (!sendMemoryMutationError(response, error)) throw error
      }
    }
  ),

  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/memory/:memoryId/reject',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      const memoryId = getMemoryId(response, params)
      if (!workspaceId || !memoryId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      try {
        sendJson(response, 200, {
          memory: serializeMemoryEntry(store.rejectMemoryCandidate(workspaceId, memoryId)),
          ok: true,
        })
      } catch (error) {
        if (!sendMemoryMutationError(response, error)) throw error
      }
    }
  ),

  route(
    'POST',
    '/api/ui/workspaces/:workspaceId/memory/:memoryId/archive',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      const memoryId = getMemoryId(response, params)
      if (!workspaceId || !memoryId) return
      if (!requireWorkspace(response, store, workspaceId)) return
      try {
        sendJson(response, 200, {
          memory: serializeMemoryEntry(store.archiveMemoryEntry(workspaceId, memoryId)),
          ok: true,
        })
      } catch (error) {
        if (!sendMemoryMutationError(response, error)) throw error
      }
    }
  ),
]
