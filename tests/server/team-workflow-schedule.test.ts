import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
afterEach(() => {
  delete process.env.HIVE_DATA_DIR
  for (const d of tempDirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

const setup = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'team-wf-schedule-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  tempDirs.push(dataDir)
  const passiveScript = join(workspacePath, 'passive.js')
  writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")

  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const uiCookie = await getUiCookie(baseUrl)

  // Workflows are an experimental opt-in (off by default); enable so the
  // `team workflow schedule` happy path under test is reachable.
  await fetch(`${baseUrl}/api/settings/workflow-feature`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ enabled: true }),
  })

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`

  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({
      command: process.execPath,
      args: [passiveScript],
    }),
  })
  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ hive_port: String(hive.port) }),
  })

  return { baseUrl, hive, orchestratorId, uiCookie, workspaceId: workspace.id, workspacePath }
}

const SOURCE = "export const meta = { name: 'nightly', description: 'd' }\nreturn 'ok'"

describe('team workflow schedule (agent-initiated scheduling)', () => {
  test('persists the inline source to .hive/workflows and registers a schedule row', async () => {
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          source: SOURCE,
          name: 'Nightly Audit',
          cron: '0 3 * * *',
        }),
      })
      expect(resp.status).toBe(201)
      const body = (await resp.json()) as {
        ok: boolean
        schedule_id: string
        script_path: string
        next_run_at: number
      }
      expect(body.ok).toBe(true)
      // The agent's source was persisted to a slugified file under the
      // workspace's .hive/workflows so the file-based scheduler can load it
      // when cron fires (no orchestrator in the loop at fire time).
      expect(body.script_path).toContain(join('.hive', 'workflows'))
      expect(body.script_path.split(/[\\/]/).at(-1)).toMatch(/^nightly-audit-[0-9a-f-]{36}\.ts$/)
      expect(existsSync(body.script_path)).toBe(true)
      expect(readFileSync(body.script_path, 'utf8')).toBe(SOURCE)
      expect(body.next_run_at).toBeGreaterThan(Date.now())

      // A real schedule row exists, enabled, pointing at the persisted file.
      const schedules = ctx.hive.store.listWorkspaceWorkflowSchedules(ctx.workspaceId)
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(body.schedule_id)
      expect(schedules[0]?.scriptPath).toBe(body.script_path)
      expect(schedules[0]?.cron).toBe('0 3 * * *')
      expect(schedules[0]?.enabled).toBe(true)

      // It surfaces through the UI list route (view/control path stays human-facing).
      const listResp = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workflow-schedules`,
        { headers: { cookie: ctx.uiCookie } }
      )
      const listBody = (await listResp.json()) as { schedules: Array<{ id: string }> }
      expect(listBody.schedules.map((s) => s.id)).toContain(body.schedule_id)
    } finally {
      await ctx.hive.close()
    }
  })

  test('is rejected with a clear error when the experimental workflow feature is disabled', async () => {
    const ctx = await setup()
    try {
      // setup() enabled workflows; turn them back off for this case.
      await fetch(`${ctx.baseUrl}/api/settings/workflow-feature`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: ctx.uiCookie },
        body: JSON.stringify({ enabled: false }),
      })
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          source: SOURCE,
          name: 'Nightly Audit',
          cron: '0 3 * * *',
        }),
      })
      expect(resp.status).toBe(403)
      const body = (await resp.json()) as { error?: string }
      expect(body.error ?? '').toMatch(/disabled|experimental/i)
      // No schedule row was created.
      expect(ctx.hive.store.listWorkspaceWorkflowSchedules(ctx.workspaceId)).toHaveLength(0)
    } finally {
      await ctx.hive.close()
    }
  })

  test('keeps same-name schedules on distinct source files instead of overwriting', async () => {
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const create = async (source: string) => {
        const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/schedule`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project_id: ctx.workspaceId,
            from_agent_id: ctx.orchestratorId,
            token: orchToken,
            source,
            name: 'Nightly Audit',
            cron: '0 3 * * *',
          }),
        })
        expect(resp.status).toBe(201)
        return (await resp.json()) as { schedule_id: string; script_path: string }
      }

      const firstSource = `${SOURCE}\n// first`
      const secondSource = `${SOURCE}\n// second`
      const first = await create(firstSource)
      const second = await create(secondSource)

      expect(first.script_path).not.toBe(second.script_path)
      expect(readFileSync(first.script_path, 'utf8')).toBe(firstSource)
      expect(readFileSync(second.script_path, 'utf8')).toBe(secondSource)

      const schedules = ctx.hive.store.listWorkspaceWorkflowSchedules(ctx.workspaceId)
      expect(schedules).toHaveLength(2)
      expect(schedules.map((schedule) => schedule.scriptPath).sort()).toEqual(
        [first.script_path, second.script_path].sort()
      )
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects an invalid cron expression with 400 and writes nothing', async () => {
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          source: SOURCE,
          name: 'bad',
          cron: 'not-a-cron',
        }),
      })
      expect(resp.status).toBe(400)
      expect(existsSync(join(ctx.workspacePath, '.hive', 'workflows', 'bad.ts'))).toBe(false)
      expect(ctx.hive.store.listWorkspaceWorkflowSchedules(ctx.workspaceId)).toHaveLength(0)
    } finally {
      await ctx.hive.close()
    }
  })

  test('rejects schedule names that would create reserved Windows device files', async () => {
    const ctx = await setup()
    try {
      const orchToken = ctx.hive.store.peekAgentToken(ctx.orchestratorId)
      if (!orchToken) throw new Error('Expected orchestrator token')

      const resp = await fetch(`${ctx.baseUrl}/api/team/workflow/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: ctx.workspaceId,
          from_agent_id: ctx.orchestratorId,
          token: orchToken,
          source: SOURCE,
          name: 'NUL',
          cron: '0 3 * * *',
        }),
      })
      expect(resp.status).toBe(400)
      const body = (await resp.json()) as { error?: string }
      expect(body.error).toMatch(/reserved Windows device name/i)
      expect(existsSync(join(ctx.workspacePath, '.hive', 'workflows', 'nul.ts'))).toBe(false)
      expect(ctx.hive.store.listWorkspaceWorkflowSchedules(ctx.workspaceId)).toHaveLength(0)
    } finally {
      await ctx.hive.close()
    }
  })
})
