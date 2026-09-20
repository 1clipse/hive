import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { WORKFLOW_ENABLED_KEY } from '../../src/server/workflow-feature.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

// The sibling + sidecar cases require three simultaneous agent slots. Fix only
// CPU capacity (5 cores -> 3 slots); HTTP, SQLite, PTY and reports remain real.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  const cpu = os.cpus()[0]
  return { ...os, cpus: () => Array.from({ length: 5 }, () => cpu) }
})

const waitForValue = async <T>(read: () => T | Promise<T | undefined> | undefined) => {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitForValue timeout')
}

type TestServer = Awaited<ReturnType<typeof startTestServer>>
type WorkspaceRecord = ReturnType<TestServer['store']['createWorkspace']>

interface WorkflowHttpHarness {
  close: () => Promise<void>
  orchestratorId: string
  orchestratorToken: string
  server: TestServer
  workspace: WorkspaceRecord
}

const createWorkflowHttpHarness = async (): Promise<WorkflowHttpHarness> => {
  const server = await startTestServer()
  const originalPath = process.env.PATH
  const workspacePath = join(server.dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  prependPassiveWorkflowCliPath(server.dataDir, ['claude'], originalPath)
  const workspace = server.store.createWorkspace(workspacePath, 'WS')
  const orchestratorId = `${workspace.id}:orchestrator`
  server.store.configureAgentLaunch(workspace.id, orchestratorId, {
    command: 'claude',
    args: [],
  })
  const orchestrator = await server.store.startAgent(workspace.id, orchestratorId, {
    hivePort: '0',
  })
  await orchestrator.postStartInputReady
  const orchestratorToken = server.store.peekAgentToken(orchestratorId)
  if (!orchestratorToken) throw new Error('Expected orchestrator token')
  server.store.settings.setAppState(WORKFLOW_ENABLED_KEY, JSON.stringify(true))

  return {
    close: async () => {
      process.env.PATH = originalPath
      await server.close()
    },
    orchestratorId,
    orchestratorToken,
    server,
    workspace,
  }
}

const runInlineWorkflowOverHttp = async (
  harness: WorkflowHttpHarness,
  name: string,
  source: string
): Promise<string> => {
  const runResponse = await fetch(`${harness.server.baseUrl}/api/team/workflow/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: harness.workspace.id,
      from_agent_id: harness.orchestratorId,
      token: harness.orchestratorToken,
      name,
      source,
    }),
  })
  expect(runResponse.status).toBe(202)
  const runPayload = (await runResponse.json()) as { run_id: string }
  return runPayload.run_id
}

const reportDispatchOverHttp = async (
  harness: WorkflowHttpHarness,
  dispatch: DispatchRecord,
  result: string
) => {
  const workerToken = await waitForValue(() =>
    harness.server.store.peekAgentToken(dispatch.toAgentId)
  )
  const reportResponse = await fetch(`${harness.server.baseUrl}/api/team/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: harness.workspace.id,
      from_agent_id: dispatch.toAgentId,
      token: workerToken,
      dispatch_id: dispatch.id,
      result,
    }),
  })
  expect(reportResponse.status).toBe(202)
}

const stopWorkflowOverUi = async (harness: WorkflowHttpHarness, runId: string) => {
  const cookie = await getUiCookie(harness.server.baseUrl)
  const stopResponse = await fetch(`${harness.server.baseUrl}/api/workflows/runs/${runId}/stop`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(stopResponse.status).toBe(202)
}

describe('workflow dag HTTP reporting', () => {
  test('completes a DAG agent node through /api/team/report', async () => {
    const harness = await createWorkflowHttpHarness()
    try {
      const runId = await runInlineWorkflowOverHttp(
        harness,
        'dag-http-report',
        [
          "export const meta = { name: 'dag-http-report', description: 'http report path' }",
          'return await dag([',
          "  { id: 'root', run: () => agent('root via http', { label: 'root-http' }) },",
          '])',
        ].join('\n')
      )

      const dispatch = await waitForValue(() =>
        harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .find((item) => item.workflowRunId === runId)
      )

      await reportDispatchOverHttp(harness, dispatch, 'reported over HTTP')

      const final = await waitForValue(() => {
        const run = harness.server.store.getWorkflowRun(runId)
        return run?.status === 'completed' ? run : undefined
      })
      expect(final.result).toEqual({
        order: ['root'],
        results: { root: 'reported over HTTP' },
      })
    } finally {
      await harness.close()
    }
  }, 20_000)

  test('cancels awaited DAG siblings through HTTP without cancelling a sidecar spawned after DAG start', async () => {
    const harness = await createWorkflowHttpHarness()
    try {
      const runId = await runInlineWorkflowOverHttp(
        harness,
        'dag-http-async-sidecar',
        [
          "export const meta = { name: 'dag-http-async-sidecar', description: 'async dag sidecar isolation' }",
          'const dagResultPromise = dag([',
          "  { id: 'slow', run: async () => { await Promise.resolve(); return await agent('dag slow sibling', { label: 'slow', timeoutMs: 10000 }) } },",
          "  { id: 'boom', run: async () => { await agent('dag boom sibling', { label: 'boom', timeoutMs: 10000 }); throw new Error('boom') } },",
          ']).then(',
          '  (value) => ({ ok: true, value }),',
          '  (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })',
          ')',
          "const sidecarResult = await agent('sidecar after dag start', { label: 'sidecar', timeoutMs: 10000 })",
          'const dagResult = await dagResultPromise',
          'if (!dagResult.ok) throw new Error(dagResult.error)',
          'return { sidecarResult, dagResult: dagResult.value }',
        ].join('\n')
      )

      const dispatches = await waitForValue(() => {
        const current = harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .filter((item) => item.workflowRunId === runId)
        return current.length >= 3 ? current : undefined
      })
      const slow = dispatches.find((dispatch) => dispatch.text === 'dag slow sibling')
      const boom = dispatches.find((dispatch) => dispatch.text === 'dag boom sibling')
      const sidecar = dispatches.find((dispatch) => dispatch.text === 'sidecar after dag start')
      if (!slow || !boom || !sidecar) throw new Error('Expected slow, boom, and sidecar dispatches')

      await reportDispatchOverHttp(harness, boom, 'boom ready')

      const cancelledSlow = await waitForValue(() => {
        const current = harness.server.store
          .listWorkflowRunDispatches(runId)
          .find((dispatch) => dispatch.id === slow.id)
        return current?.status === 'cancelled' ? current : undefined
      })
      expect(cancelledSlow.reportText).toMatch(/DAG node failed: .*boom/)

      const sidecarAfterDagCancel = harness.server.store
        .listWorkflowRunDispatches(runId)
        .find((dispatch) => dispatch.id === sidecar.id)
      expect(sidecarAfterDagCancel?.status).toBe('submitted')

      await reportDispatchOverHttp(harness, sidecar, 'sidecar survived')

      const final = await waitForValue(() => {
        const run = harness.server.store.getWorkflowRun(runId)
        return run?.status === 'failed' ? run : undefined
      })
      expect(final.error).toMatch(/boom/)
      const reportedSidecar = harness.server.store
        .listWorkflowRunDispatches(runId)
        .find((dispatch) => dispatch.id === sidecar.id)
      expect(reportedSidecar?.status).toBe('reported')
    } finally {
      await harness.close()
    }
  }, 20_000)

  test('fails fast and cancels a non-reporting sidecar when a DAG node fails', async () => {
    const harness = await createWorkflowHttpHarness()
    try {
      const runId = await runInlineWorkflowOverHttp(
        harness,
        'dag-http-fail-sidecar-no-report',
        [
          "export const meta = { name: 'dag-http-fail-sidecar-no-report', description: 'sidecar cleanup' }",
          "void agent('sidecar never reports', { label: 'sidecar', timeoutMs: 10000 }).catch(() => null)",
          'return await dag([',
          "  { id: 'slow', run: () => agent('dag slow sibling', { label: 'slow', timeoutMs: 10000 }) },",
          "  { id: 'boom', run: async () => { await agent('dag boom sibling', { label: 'boom', timeoutMs: 10000 }); throw new Error('boom') } },",
          '])',
        ].join('\n')
      )

      const dispatches = await waitForValue(() => {
        const current = harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .filter((item) => item.workflowRunId === runId)
        return current.length >= 3 ? current : undefined
      })
      const boom = dispatches.find((dispatch) => dispatch.text === 'dag boom sibling')
      const sidecar = dispatches.find((dispatch) => dispatch.text === 'sidecar never reports')
      if (!boom || !sidecar) throw new Error('Expected boom and sidecar dispatches')

      await reportDispatchOverHttp(harness, boom, 'boom ready')

      const final = await waitForValue(() => {
        const run = harness.server.store.getWorkflowRun(runId)
        return run?.status === 'failed' ? run : undefined
      })
      expect(final.error).toMatch(/boom/)

      const cancelledSidecar = await waitForValue(() => {
        const current = harness.server.store
          .listWorkflowRunDispatches(runId)
          .find((dispatch) => dispatch.id === sidecar.id)
        return current?.status === 'cancelled' ? current : undefined
      })
      expect(cancelledSidecar.reportText).toMatch(/boom/)
      expect(harness.server.store.listWorkers(harness.workspace.id)).toHaveLength(0)
    } finally {
      await harness.close()
    }
  }, 20_000)

  test('lets a workflow continue after catching a DAG node failure', async () => {
    const harness = await createWorkflowHttpHarness()
    try {
      const runId = await runInlineWorkflowOverHttp(
        harness,
        'dag-http-catch-then-agent',
        [
          "export const meta = { name: 'dag-http-catch-then-agent', description: 'catch dag failure' }",
          'const dagResult = await dag([',
          "  { id: 'slow', run: () => agent('dag catch slow sibling', { label: 'slow', timeoutMs: 10000 }) },",
          "  { id: 'boom', run: async () => { await agent('dag catch boom sibling', { label: 'boom', timeoutMs: 10000 }); throw new Error('boom') } },",
          ']).then(',
          '  (value) => ({ ok: true, value }),',
          '  (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })',
          ')',
          "const after = await agent('after caught dag failure', { label: 'after', timeoutMs: 10000 })",
          'return { dagOk: dagResult.ok, dagError: dagResult.error, after }',
        ].join('\n')
      )

      const initialDispatches = await waitForValue(() => {
        const current = harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .filter((item) => item.workflowRunId === runId)
        return current.length >= 2 ? current : undefined
      })
      const slow = initialDispatches.find((dispatch) => dispatch.text === 'dag catch slow sibling')
      const boom = initialDispatches.find((dispatch) => dispatch.text === 'dag catch boom sibling')
      if (!slow || !boom) throw new Error('Expected slow and boom DAG dispatches')

      await reportDispatchOverHttp(harness, boom, 'boom ready')

      const cancelledSlow = await waitForValue(() => {
        const current = harness.server.store
          .listWorkflowRunDispatches(runId)
          .find((dispatch) => dispatch.id === slow.id)
        return current?.status === 'cancelled' ? current : undefined
      })
      expect(cancelledSlow.reportText).toMatch(/DAG node failed: .*boom/)

      const after = await waitForValue(() =>
        harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .find((item) => item.workflowRunId === runId && item.text === 'after caught dag failure')
      )
      await reportDispatchOverHttp(harness, after, 'continued after catch')

      const final = await waitForValue(() => {
        const run = harness.server.store.getWorkflowRun(runId)
        return run?.status === 'completed' ? run : undefined
      })
      expect(final.result).toEqual({
        after: 'continued after catch',
        dagError: expect.stringMatching(/boom/),
        dagOk: false,
      })
    } finally {
      await harness.close()
    }
  }, 20_000)

  test('stops a DAG run through the UI HTTP route and cancels open dispatches', async () => {
    const harness = await createWorkflowHttpHarness()
    try {
      const runId = await runInlineWorkflowOverHttp(
        harness,
        'dag-http-ui-stop',
        [
          "export const meta = { name: 'dag-http-ui-stop', description: 'ui stop path' }",
          'return await dag([',
          "  { id: 'a', run: () => agent('dag stop a', { label: 'a', timeoutMs: 10000 }) },",
          "  { id: 'b', run: () => agent('dag stop b', { label: 'b', timeoutMs: 10000 }) },",
          '])',
        ].join('\n')
      )

      const stopDispatches = await waitForValue(() => {
        const current = harness.server.store
          .listDispatches(harness.workspace.id, { status: 'submitted' })
          .filter((item) => item.workflowRunId === runId)
        return current.length >= 2 ? current : undefined
      })
      const stopDispatchIds = stopDispatches.map((dispatch) => dispatch.id).sort()

      await stopWorkflowOverUi(harness, runId)

      const final = await waitForValue(() => {
        const run = harness.server.store.getWorkflowRun(runId)
        return run?.status === 'stopped' ? run : undefined
      })
      expect(final.error).toMatch(/Stopped by user/)
      const finalDispatches = harness.server.store.listWorkflowRunDispatches(runId)
      expect(finalDispatches.map((dispatch) => dispatch.id).sort()).toEqual(stopDispatchIds)
      expect(finalDispatches.every((dispatch) => dispatch.status === 'cancelled')).toBe(true)
      expect(harness.server.store.listWorkers(harness.workspace.id)).toHaveLength(0)
    } finally {
      await harness.close()
    }
  }, 20_000)
})
