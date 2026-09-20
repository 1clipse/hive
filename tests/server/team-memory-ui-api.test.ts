import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let server: Awaited<ReturnType<typeof startTestServer>> | undefined
let cookie = ''
const tempDirs: string[] = []

beforeEach(async () => {
  server = await startTestServer()
  cookie = await getUiCookie(server.baseUrl)
})

afterEach(async () => {
  await server?.close()
  server = undefined
  cookie = ''
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const uiFetch = (path: string, init: RequestInit = {}) => {
  if (!server) throw new Error('Expected test server')
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      cookie,
      ...init.headers,
    },
  })
}

const createWorkspace = () => {
  if (!server) throw new Error('Expected test server')
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-ui-api-'))
  tempDirs.push(workspacePath)
  return server.store.createWorkspace(workspacePath, 'Alpha')
}

describe('/api/ui/workspaces/:workspaceId/memory', () => {
  test('UI can review candidates, mutate active memory, change settings, and inspect injections', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })

    const active = server.store.addMemoryEntry({
      actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
      body: 'Use pnpm when running project scripts.',
      kind: 'decision',
      tags: ['tooling'],
      workspaceId: workspace.id,
    })
    const userMemory = server.store.addMemoryEntry({
      actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
      body: 'Prefer short release checklists.',
      kind: 'preference',
      scope: 'user',
      workspaceId: workspace.id,
    })
    const procedureMemory = server.store.addMemoryEntry({
      actor: { id: orchestrator.id, name: orchestrator.name, role: orchestrator.role },
      body: 'Use the release checklist workflow for package publishing.',
      kind: 'procedure_ref',
      procedureRef: { id: 'release-checklist', title: 'Release checklist', type: 'workflow' },
      workspaceId: workspace.id,
    })
    const candidate = server.store.addMemoryEntry({
      actor: { id: worker.id, name: worker.name, role: worker.role },
      body: 'Worker found a setup pitfall.',
      kind: 'pitfall',
      tags: ['setup'],
      workspaceId: workspace.id,
    })
    const rejectedCandidate = server.store.addMemoryEntry({
      actor: { id: worker.id, name: worker.name, role: worker.role },
      body: 'Reject this noisy candidate.',
      kind: 'fact',
      workspaceId: workspace.id,
    })
    server.store.logMemoryInjections({
      contextType: 'dispatch',
      dispatchId: 'dispatch-1',
      memoryIds: [active.id],
      targetAgentIdSnapshot: worker.id,
      workspaceId: workspace.id,
    })

    const activeListResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory?status=active&scope=all`
    )
    expect(activeListResponse.status).toBe(200)
    await expect(activeListResponse.json()).resolves.toEqual({
      memories: expect.arrayContaining([
        expect.objectContaining({
          body: 'Use pnpm when running project scripts.',
          id: active.id,
          status: 'active',
          tags: ['tooling'],
        }),
        expect.objectContaining({
          body: 'Prefer short release checklists.',
          id: userMemory.id,
          scope: 'user',
          workspace_id: null,
        }),
      ]),
      ok: true,
    })

    const candidateListResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory?status=candidate`
    )
    expect(candidateListResponse.status).toBe(200)
    await expect(candidateListResponse.json()).resolves.toEqual({
      memories: expect.arrayContaining([
        expect.objectContaining({ id: candidate.id, status: 'candidate' }),
        expect.objectContaining({ id: rejectedCandidate.id, status: 'candidate' }),
      ]),
      ok: true,
    })

    const updateResponse = await uiFetch(`/api/ui/workspaces/${workspace.id}/memory/${active.id}`, {
      body: JSON.stringify({ disabled: true, pinned: true }),
      method: 'PATCH',
    })
    expect(updateResponse.status).toBe(200)
    await expect(updateResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({ disabled: true, id: active.id, pinned: true }),
      ok: true,
    })

    const searchResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory?status=active&query=pnpm`
    )
    expect(searchResponse.status).toBe(200)
    await expect(searchResponse.json()).resolves.toEqual({
      memories: [expect.objectContaining({ disabled: true, id: active.id })],
      ok: true,
    })

    const approveResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/${candidate.id}/approve`,
      { method: 'POST' }
    )
    expect(approveResponse.status).toBe(200)
    await expect(approveResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({ id: candidate.id, status: 'active' }),
      ok: true,
    })

    const rejectResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/${rejectedCandidate.id}/reject`,
      { method: 'POST' }
    )
    expect(rejectResponse.status).toBe(200)
    await expect(rejectResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({ id: rejectedCandidate.id, status: 'rejected' }),
      ok: true,
    })

    const injectionsResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/injections?dispatch_id=dispatch-1`
    )
    expect(injectionsResponse.status).toBe(200)
    await expect(injectionsResponse.json()).resolves.toEqual({
      injections: [
        expect.objectContaining({
          context_type: 'dispatch',
          dispatch_id: 'dispatch-1',
          memory: expect.objectContaining({ id: active.id }),
          memory_id: active.id,
          target_agent_id_snapshot: worker.id,
        }),
      ],
      ok: true,
    })

    const diagnosticsResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/diagnostics?query=release`
    )
    expect(diagnosticsResponse.status).toBe(200)
    await expect(diagnosticsResponse.json()).resolves.toEqual({
      diagnostics: expect.objectContaining({
        entries: expect.objectContaining({
          active_injectable: 3,
          by_scope: { user: 1, workspace: 4 },
          by_source: { dream: 0, manual: 5 },
          by_status: { active: 4, archived: 0, candidate: 0, rejected: 1 },
          disabled: 1,
          never_injected_active: 3,
          procedure_refs: 1,
          stale_active: 0,
          total: 5,
        }),
        dreams: expect.objectContaining({
          by_status: { completed: 0, failed: 0, reverted: 0, running: 0 },
          operations: { added: 0, archived: 0, merged: 0, rewritten: 0 },
          total: 0,
        }),
        injections: expect.objectContaining({
          by_context: { dispatch: 1, manual_search: 0, recovery: 0, startup: 0 },
          distinct_memories: 1,
          total: 1,
        }),
        provider: expect.objectContaining({
          provider: 'local_sqlite',
          retrieval: expect.objectContaining({ semantic_provider: 'not_configured' }),
        }),
        retrieval: expect.objectContaining({
          query: 'release',
          result_count: 2,
          results: expect.arrayContaining([
            expect.objectContaining({ id: userMemory.id, scope: 'user' }),
            expect.objectContaining({
              id: procedureMemory.id,
              procedure_ref: {
                id: 'release-checklist',
                title: 'Release checklist',
                type: 'workflow',
              },
              scope: 'workspace',
            }),
          ]),
        }),
        workspace_id: workspace.id,
      }),
      ok: true,
    })

    const archiveResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/${active.id}/archive`,
      { method: 'POST' }
    )
    expect(archiveResponse.status).toBe(200)
    await expect(archiveResponse.json()).resolves.toEqual({
      memory: expect.objectContaining({ id: active.id, status: 'archived' }),
      ok: true,
    })

    const settingsResponse = await uiFetch(`/api/ui/workspaces/${workspace.id}/memory/settings`)
    expect(settingsResponse.status).toBe(200)
    await expect(settingsResponse.json()).resolves.toEqual({
      dream_enabled: true,
      enabled: true,
      ok: true,
    })

    const updateSettingsResponse = await uiFetch(
      `/api/ui/workspaces/${workspace.id}/memory/settings`,
      {
        body: JSON.stringify({ dream_enabled: false, enabled: false }),
        method: 'PUT',
      }
    )
    expect(updateSettingsResponse.status).toBe(200)
    await expect(updateSettingsResponse.json()).resolves.toEqual({
      dream_enabled: false,
      enabled: false,
      ok: true,
    })
  })

  test('UI routes reject invalid requests and preserve memory status boundaries', async () => {
    if (!server) throw new Error('Expected test server')
    const workspace = createWorkspace()
    const orchestrator = server.store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) throw new Error('Expected default orchestrator')
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    const candidate = server.store.addMemoryEntry({
      actor: { id: worker.id, name: worker.name, role: worker.role },
      body: 'Candidate cannot be pinned before approval.',
      kind: 'fact',
      workspaceId: workspace.id,
    })

    const noCookie = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/memory`)
    expect(noCookie.status).toBe(403)

    await expect(
      uiFetch(`/api/ui/workspaces/${workspace.id}/memory?status=working`).then((response) =>
        response.json().then((body) => [response.status, body])
      )
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      uiFetch(`/api/ui/workspaces/${workspace.id}/memory?limit=-1`).then((response) =>
        response.json().then((body) => [response.status, body])
      )
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      uiFetch(`/api/ui/workspaces/${workspace.id}/memory/injections`).then((response) =>
        response.json().then((body) => [response.status, body])
      )
    ).resolves.toEqual([400, { error: expect.any(String) }])

    await expect(
      uiFetch('/api/ui/workspaces/missing-workspace/memory').then((response) =>
        response.json().then((body) => [response.status, body])
      )
    ).resolves.toEqual([404, { error: expect.any(String) }])

    await expect(
      uiFetch('/api/ui/workspaces/missing-workspace/memory/settings', {
        body: JSON.stringify({ enabled: false }),
        method: 'PUT',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([404, { error: expect.any(String) }])

    await expect(
      uiFetch(`/api/ui/workspaces/${workspace.id}/memory/${candidate.id}`, {
        body: JSON.stringify({ pinned: true }),
        method: 'PATCH',
      }).then((response) => response.json().then((body) => [response.status, body]))
    ).resolves.toEqual([409, { error: expect.any(String) }])
  })
})
