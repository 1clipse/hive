import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'

const dirs: string[] = []
afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

interface Ctx {
  baseUrl: string
  cookie: string
  hive: Awaited<ReturnType<typeof runHiveCommand>>
  workspaceId: string
  workspacePath: string
}

const setup = async (): Promise<Ctx> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-sched-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(workspacePath, { recursive: true })
  dirs.push(dataDir)
  process.env.HIVE_DATA_DIR = dataDir
  const hive = await runHiveCommand(['--port', '0'])
  const baseUrl = `http://127.0.0.1:${hive.port}`
  const cookie = await getUiCookie(baseUrl)
  const wsResp = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
  })
  const ws = (await wsResp.json()) as { id: string }
  return { baseUrl, cookie, hive, workspaceId: ws.id, workspacePath }
}

// Schedules are created by the orchestrator agent (`team workflow schedule`),
// which lands as store.scheduleWorkflowInline. These tests cover the UI-facing
// view/control routes (list / patch / delete) — creation is exercised end-to-end
// in team-workflow-schedule.test.ts.
const seedSchedule = (ctx: Ctx) =>
  ctx.hive.store.scheduleWorkflowInline({
    workspaceId: ctx.workspaceId,
    source: "export const meta = { name: 'review', description: 'd' }\nreturn 'x'",
    name: 'review',
    cron: '0 9 * * 1',
    nextRunAt: Date.now() + 60_000,
  })

describe('workflow-schedules HTTP routes (view/control only)', () => {
  test('list → patch (disable) → delete cycle', async () => {
    const ctx = await setup()
    try {
      const created = await seedSchedule(ctx)
      expect(created.enabled).toBe(true)

      // List surfaces the agent-created schedule.
      const listResp = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workflow-schedules`,
        { headers: { cookie: ctx.cookie } }
      )
      const list = (await listResp.json()) as { schedules: Array<{ id: string; cron: string }> }
      expect(list.schedules.some((s) => s.id === created.id && s.cron === '0 9 * * 1')).toBe(true)

      // Patch (pause).
      const patchResp = await fetch(`${ctx.baseUrl}/api/workflow-schedules/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ enabled: false }),
      })
      expect(patchResp.status).toBe(200)
      const patched = (await patchResp.json()) as { schedule: { enabled: boolean } }
      expect(patched.schedule.enabled).toBe(false)

      // Delete.
      const delResp = await fetch(`${ctx.baseUrl}/api/workflow-schedules/${created.id}`, {
        method: 'DELETE',
        headers: { cookie: ctx.cookie },
      })
      expect(delResp.status).toBe(200)

      const listAfter = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workflow-schedules`,
        { headers: { cookie: ctx.cookie } }
      )
      const afterPayload = (await listAfter.json()) as { schedules: Array<{ id: string }> }
      expect(afterPayload.schedules.some((s) => s.id === created.id)).toBe(false)
    } finally {
      await ctx.hive.close()
    }
  })

  test('PATCH with an invalid cron returns 400', async () => {
    const ctx = await setup()
    try {
      const created = await seedSchedule(ctx)
      const r = await fetch(`${ctx.baseUrl}/api/workflow-schedules/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: ctx.cookie },
        body: JSON.stringify({ cron: 'not-a-cron' }),
      })
      expect(r.status).toBe(400)
    } finally {
      await ctx.hive.close()
    }
  })

  test('PATCH on unknown schedule returns 404', async () => {
    const ctx = await setup()
    try {
      const r = await fetch(
        `${ctx.baseUrl}/api/workflow-schedules/00000000-0000-0000-0000-000000000000`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', cookie: ctx.cookie },
          body: JSON.stringify({ enabled: false }),
        }
      )
      expect(r.status).toBe(404)
    } finally {
      await ctx.hive.close()
    }
  })
})
