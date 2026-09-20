import { isExternalGoalReportStatus } from './external-goal-store.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { GoalReportBody, RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const BODY_MAX_CHARS = 40_000

const requireNonEmptyString = (value: unknown, field: string, maxChars = BODY_MAX_CHARS) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  if ([...value].length > maxChars) {
    throw new BadRequestError(`${field} must be ${maxChars} characters or fewer`)
  }
  return value
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const teamGoalRoutes: RouteDefinition[] = [
  route('POST', '/api/team/goal/report', async ({ request, response, store }) => {
    const body = await readJsonBody<GoalReportBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id', 200)
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id', 200)
    const goalId = requireNonEmptyString(body.goal_id, 'goal_id', 200)
    const resultText = requireNonEmptyString(body.result, 'result')
    if (!isExternalGoalReportStatus(body.status)) {
      throw new BadRequestError('Invalid status; expected progress, done, blocked, or failed')
    }
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
    })
    requireCommandForRole(agent, 'goal_report')
    const result = store.reportExternalGoal({
      artifacts: getArtifacts(body.artifacts),
      body: resultText,
      fromAgentId,
      goalId,
      status: body.status,
      workspaceId: projectId,
    })
    sendJson(response, 202, {
      cursor: result.cursor,
      event: {
        artifacts: result.event.artifacts,
        body: result.event.body,
        created_at: result.event.createdAt,
        goal_id: result.event.goalId,
        id: result.event.id,
        kind: result.event.kind,
        sequence: result.event.sequence,
        status: result.event.status,
        workspace_id: result.event.workspaceId,
      },
      goal_id: goalId,
      ok: true,
      status: result.status,
    })
  }),
]
