import { getRequiredParam, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'
import { serializeWorkflowDispatch, serializeWorkflowRun } from './workflow-http-serializers.js'

// Workflows are authored and fired by the orchestrator agent (`team workflow
// run` / `team workflow schedule`), never from a human script library — so the
// UI surface here is purely OBSERVABILITY + run control (list / get / stop /
// per-agent dispatch timeline / narrator logs). There is no list-scripts,
// start-by-path, template-install, or source-editor route.
export const workflowRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/workflows/runs',
    ({ params, request, response, store }) => {
      requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
      const workspaceId = getRequiredParam(response, params, 'workspaceId', 'Missing workspaceId')
      if (!workspaceId) return
      sendJson(response, 200, {
        runs: store.listWorkspaceWorkflowRuns(workspaceId).map(serializeWorkflowRun),
      })
    }
  ),
  route('GET', '/api/workflows/runs/:runId', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const runId = getRequiredParam(response, params, 'runId', 'Missing runId')
    if (!runId) return
    const run = store.getWorkflowRun(runId)
    if (!run) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    sendJson(response, 200, { run: serializeWorkflowRun(run) })
  }),
  route('POST', '/api/workflows/runs/:runId/stop', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const runId = getRequiredParam(response, params, 'runId', 'Missing runId')
    if (!runId) return
    const run = store.getWorkflowRun(runId)
    if (!run) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    const stopped = store.stopWorkflowRun(runId)
    sendJson(response, stopped ? 202 : 409, {
      ok: stopped,
      ...(stopped ? {} : { error: `Run is not running (status=${run.status})` }),
    })
  }),
  route('GET', '/api/workflows/runs/:runId/dispatches', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const runId = getRequiredParam(response, params, 'runId', 'Missing runId')
    if (!runId) return
    const run = store.getWorkflowRun(runId)
    if (!run) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    /* TIER 2 #6 — enrich `submitted` dispatches with the worker's
       lastPtyLine so the Drawer can show what each ephemeral worker is
       currently doing (without forcing the user to jump to the
       worker's terminal pane). For reported/cancelled rows the report
       text is already authoritative, no need to also surface PTY noise. */
    const dispatches = store.listWorkflowRunDispatches(runId).map((d) => {
      if (d.status !== 'submitted') return d
      const lastPtyLine = store.getLastPtyLineForAgent(run.workspaceId, d.toAgentId)
      return lastPtyLine === null ? d : { ...d, lastPtyLine }
    })
    sendJson(response, 200, { dispatches: dispatches.map(serializeWorkflowDispatch) })
  }),
  /* TIER 2 #3 — narrator lane. Drawer polls this alongside dispatches.
     Same auth path; same 404 semantics. */
  route('GET', '/api/workflows/runs/:runId/logs', ({ params, request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
    const runId = getRequiredParam(response, params, 'runId', 'Missing runId')
    if (!runId) return
    if (!store.getWorkflowRun(runId)) {
      sendJson(response, 404, { error: `Workflow run not found: ${runId}` })
      return
    }
    sendJson(response, 200, { logs: store.listWorkflowRunLogs(runId) })
  }),
]
