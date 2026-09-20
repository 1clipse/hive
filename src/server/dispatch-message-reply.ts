import type { DispatchMessageRecord } from '../shared/team-collaboration.js'

/** Formats a persisted question's reverse route; authorization is rechecked on send. */
export const buildDispatchQuestionReplyCommand = (message: DispatchMessageRecord) => {
  if (message.kind !== 'question') return null
  const orchestratorId = `${message.workspaceId}:orchestrator`
  const fromOrchestrator = message.fromAgentId === orchestratorId
  const toOrchestrator = message.recipientAgentId === orchestratorId
  const replyTarget =
    fromOrchestrator || toOrchestrator ? message.dispatchId : message.sourceDispatchId
  if (!replyTarget) return null
  const source =
    !fromOrchestrator && !toOrchestrator ? ` --from-dispatch ${message.dispatchId}` : ''
  const recipient = fromOrchestrator ? ' --to orchestrator' : ''
  return `team message --dispatch ${replyTarget}${source}${recipient} --kind answer --reply-to ${message.id} --stdin`
}
