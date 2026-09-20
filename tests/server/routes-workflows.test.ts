import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  scriptPath: string
  workspaceId: string
  workspacePath: string
}

const setup = async (): Promise<Ctx> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-routes-'))
  const workspacePath = join(dataDir, 'ws')
  mkdirSync(join(workspacePath, '.hive/workflows'), { recursive: true })
  dirs.push(dataDir)
  const scriptPath = join(workspacePath, '.hive/workflows/noop.ts')
  writeFileSync(scriptPath, "export const meta = { name: 'noop', description: 'd' }\nreturn 1")
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
  return { baseUrl, cookie, hive, scriptPath, workspaceId: ws.id, workspacePath }
}

const waitForRunStatus = async (ctx: Ctx, runId: string, status: string, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const r = await fetch(`${ctx.baseUrl}/api/workflows/runs/${runId}`, {
      headers: { cookie: ctx.cookie },
    })
    if (r.ok) {
      const payload = (await r.json()) as { run: { status: string } }
      if (payload.run.status === status) return payload.run
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Run ${runId} never reached status=${status}`)
}

// These are the OBSERVABILITY routes — runs are fired by the orchestrator
// (`team workflow run`) or the scheduler, not by a human start-by-path route.
// We seed a run via store.startWorkflow (the same entry the scheduler uses)
// and assert the read routes surface it.
describe('workflow HTTP routes (observability)', () => {
  test('GET single run + list runs surface a fired run through completion', async () => {
    const ctx = await setup()
    try {
      const run = await ctx.hive.store.startWorkflow({
        workspaceId: ctx.workspaceId,
        scriptPath: ctx.scriptPath,
        hivePort: String(ctx.hive.port),
      })

      const final = await waitForRunStatus(ctx, run.id, 'completed')
      expect(final.status).toBe('completed')

      const runsResp = await fetch(
        `${ctx.baseUrl}/api/workspaces/${ctx.workspaceId}/workflows/runs`,
        { headers: { cookie: ctx.cookie } }
      )
      const runs = (await runsResp.json()) as { runs: Array<{ id: string }> }
      expect(runs.runs.find((r) => r.id === run.id)).toBeTruthy()
    } finally {
      await ctx.hive.close()
    }
  })

  test('GET /api/workflows/runs/:id returns 404 for unknown', async () => {
    const ctx = await setup()
    try {
      const r = await fetch(
        `${ctx.baseUrl}/api/workflows/runs/00000000-0000-0000-0000-000000000000`,
        { headers: { cookie: ctx.cookie } }
      )
      expect(r.status).toBe(404)
    } finally {
      await ctx.hive.close()
    }
  })
})
