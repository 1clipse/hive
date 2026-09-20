import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'
import { startTeamReview } from './team-review.js'
import { resolveWorkspaceUiLanguage } from './workspace-ui-language.js'

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value.trim()
}

const optionalNonEmptyString = (value: unknown, field: string) =>
  value === undefined || value === null || value === ''
    ? undefined
    : requireNonEmptyString(value, field)

const requireWorkspaceId = (body: Record<string, unknown>) => {
  const workspaceId = body.workspace_id ?? body.project_id
  if (typeof workspaceId === 'string' && workspaceId.trim()) return workspaceId.trim()
  throw new BadRequestError('Missing workspace_id')
}

export const teamReviewRoutes: RouteDefinition[] = [
  route('POST', '/api/team/review', async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('Expected a JSON object')
    }
    const workspaceId = requireWorkspaceId(body)
    const agent = authenticateCliAgent({
      fromAgentId: requireNonEmptyString(body.from_agent_id, 'from_agent_id'),
      getAgent: store.getAgent,
      token: typeof body.token === 'string' ? body.token : undefined,
      validateToken: store.validateAgentToken,
      workspaceId,
    })
    requireCommandForRole(agent, 'review')
    const cli = optionalNonEmptyString(body.cli, 'cli')
    const model = optionalNonEmptyString(body.model, 'model')
    const name = optionalNonEmptyString(body.name, 'name')
    const role = optionalNonEmptyString(body.role, 'role')
    const result = await startTeamReview(store, {
      workspaceId,
      fromAgentId: agent.id,
      focus: requireNonEmptyString(body.focus, 'focus'),
      hivePort: String(request.socket.localPort ?? ''),
      language: resolveWorkspaceUiLanguage(store.settings, workspaceId),
      ...(cli ? { cli } : {}),
      ...(model ? { model } : {}),
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
    })
    sendJson(response, 201, {
      cli: result.cli,
      dispatch_id: result.dispatchId,
      member_name: result.memberName,
      role: result.role,
    })
  }),
]
