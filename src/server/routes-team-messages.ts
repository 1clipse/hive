import type { DispatchMessageKind } from '../shared/team-collaboration.js'
import {
  serializeDispatchMessage,
  serializeDispatchMessagesResult,
} from './dispatch-message-serializer.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`Missing ${field}`)
  return value
}
const optionalString = (value: unknown, field: string) =>
  value === undefined ? undefined : requiredString(value, field)
export const optionalSequence = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new BadRequestError(`${field} must be a non-negative safe integer`)
  return value
}

const rejectUnknownFields = (body: Record<string, unknown>, fields: string[]) => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestError('Expected a JSON object')
  const allowed = new Set(['project_id', 'from_agent_id', 'token', ...fields])
  for (const field of Object.keys(body))
    if (!allowed.has(field)) throw new BadRequestError(`Unknown field: ${field}`)
}

export { serializeDispatchMessage } from './dispatch-message-serializer.js'

export const teamMessageRoutes: RouteDefinition[] = [
  route('POST', '/api/team/message', async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    rejectUnknownFields(body, [
      'dispatch_id',
      'source_dispatch_id',
      'recipient',
      'kind',
      'reply_to',
      'text',
    ])
    const workspaceId = requiredString(body.project_id, 'project_id')
    const agent = authenticateCliAgent({
      workspaceId,
      fromAgentId: requiredString(body.from_agent_id, 'from_agent_id'),
      token: optionalString(body.token, 'token'),
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'message')
    const kind = body.kind
    if (typeof kind !== 'string' || !['note', 'question', 'answer', 'progress'].includes(kind))
      throw new BadRequestError('kind must be note, question, answer, or progress')
    const recipient = body.recipient
    if (recipient !== undefined && recipient !== 'owner' && recipient !== 'orchestrator')
      throw new BadRequestError('recipient must be owner or orchestrator')
    const sourceDispatchId = optionalString(body.source_dispatch_id, 'source_dispatch_id')
    const replyTo = optionalString(body.reply_to, 'reply_to')
    if (kind === 'answer' && !replyTo) throw new BadRequestError('answer requires reply_to')
    const message = store.sendDispatchMessage(workspaceId, agent.id, {
      dispatchId: requiredString(body.dispatch_id, 'dispatch_id'),
      kind: kind as DispatchMessageKind,
      text: requiredString(body.text, 'text'),
      ...(sourceDispatchId !== undefined ? { sourceDispatchId } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
    })
    sendJson(response, 202, { ok: true, message: serializeDispatchMessage(message) })
  }),
  route('POST', '/api/team/messages', async ({ request, response, store }) => {
    const body = await readJsonBody<Record<string, unknown>>(request)
    rejectUnknownFields(body, ['dispatch_id', 'after_seq'])
    const workspaceId = requiredString(body.project_id, 'project_id')
    const agent = authenticateCliAgent({
      workspaceId,
      fromAgentId: requiredString(body.from_agent_id, 'from_agent_id'),
      token: optionalString(body.token, 'token'),
      getAgent: store.getAgent,
      validateToken: store.validateAgentToken,
    })
    requireCommandForRole(agent, 'messages')
    const result = store.listDispatchMessages(
      workspaceId,
      agent.id,
      requiredString(body.dispatch_id, 'dispatch_id'),
      optionalSequence(body.after_seq, 'after_seq')
    )
    sendJson(response, 200, serializeDispatchMessagesResult(result))
  }),
]
