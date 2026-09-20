import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 25
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

interface TeamMemberPayload {
  id: string
  startup_ready_at: number | null
}

const fetchTeam = async (
  baseUrl: string,
  cookie: string,
  workspaceId: string
): Promise<TeamMemberPayload[]> => {
  const response = await fetch(`${baseUrl}/api/ui/workspaces/${workspaceId}/team`, {
    headers: { cookie },
  })
  if (response.status !== 200) {
    throw new Error(`team list returned ${response.status}`)
  }
  return (await response.json()) as TeamMemberPayload[]
}

describe('team list startup_ready_at', () => {
  test('is null before start and a non-null epoch after post-start injection', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-team-list-ready-'))
    tempDirs.push(dataDir)
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const script = join(workspacePath, 'stay-alive.js')
    writeFileSync(
      script,
      ["console.log('worker-ready')", 'process.stdin.resume()', 'setInterval(() => {}, 1000)'].join(
        '\n'
      )
    )

    const server = await startTestServer({ dataDir })
    try {
      const cookie = await getUiCookie(server.baseUrl)
      const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Ready',
          path: workspacePath,
        }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspace = (await workspaceResponse.json()) as { id: string }

      const workerResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/workers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name: 'Alice', role: 'coder' }),
        }
      )
      expect(workerResponse.status).toBe(201)
      const worker = (await workerResponse.json()) as {
        id: string
        startup_ready_at: number | null
      }
      expect(worker.startup_ready_at).toBeNull()

      const beforeStart = Date.now()
      const configResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ command: process.execPath, args: [script] }),
        }
      )
      expect(configResponse.status).toBe(204)

      const port = server.baseUrl.split(':').at(-1)
      const startResponse = await fetch(
        `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ hive_port: port }),
        }
      )
      expect(startResponse.status).toBe(201)

      const run = server.store.getActiveRunByAgentId(workspace.id, worker.id)
      expect(run).toBeDefined()
      await run?.postStartInputReady

      await waitFor(async () => {
        const team = await fetchTeam(server.baseUrl, cookie, workspace.id)
        const member = team.find((item) => item.id === worker.id)
        expect(member).toBeDefined()
        expect(member && 'startup_ready_at' in member).toBe(true)
        expect(member?.startup_ready_at).toEqual(expect.any(Number))
        expect(member?.startup_ready_at).toBeGreaterThanOrEqual(beforeStart)
        expect(member?.startup_ready_at).toBeLessThanOrEqual(Date.now())
      })
    } finally {
      await server.close()
    }
  }, 15000)
})
