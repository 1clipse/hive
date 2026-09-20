import { DEFAULT_COLLABORATION_WINDOW_DAYS } from './collaboration-metrics.js'
import { buildDiagnosticsSupportBundle } from './diagnostics-support-bundle.js'
import { BadRequestError } from './http-errors.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

const parseCollaborationDays = (raw: string | null): number => {
  if (raw === null || raw === '') return DEFAULT_COLLABORATION_WINDOW_DAYS
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new BadRequestError('days must be a positive integer')
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed > 3650) {
    throw new BadRequestError('days must be between 1 and 3650')
  }
  return parsed
}

export const diagnosticsRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/diagnostics/support-bundle',
    async ({ request, response, store, versionService }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const version = await versionService.getVersionInfo()
      sendJson(response, 200, buildDiagnosticsSupportBundle({ store, version }))
    }
  ),
  /* Local retention signals (issue #23): per-day protocol event counts kept in
     SQLite. Read-only, local-only — this endpoint plus the support bundle is
     the whole consumption surface, nothing is ever transmitted. */
  route('GET', '/api/diagnostics/retention', async ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    sendJson(response, 200, store.getRetentionSignals())
  }),
  /* Local collaboration cost (issue #75): per-dispatch latency and payload
     bytes, aggregated per deliverable. Local-only — never transmitted. */
  route('GET', '/api/diagnostics/collaboration', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const workspaceId = url.searchParams.get('workspace_id')?.trim() ?? ''
    if (!workspaceId) throw new BadRequestError('workspace_id is required')
    if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) {
      sendJson(response, 404, { error: 'Workspace not found' })
      return
    }
    const days = parseCollaborationDays(url.searchParams.get('days'))
    sendJson(response, 200, store.getCollaborationMetrics(workspaceId, days))
  }),
]
