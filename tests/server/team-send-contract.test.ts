import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { runTeamCommand } from '../../src/cli/team.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

let cleanupServer: (() => Promise<void>) | undefined
const originalEnv = { ...process.env }
const tempDirs: string[] = []

beforeEach(async () => {
  const server = await startTestServer()
  cleanupServer = server.close
  const uiCookie = await getUiCookie(server.baseUrl)
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-send-contract-'))
  tempDirs.push(workspacePath)

  const workspaceResponse = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
  })
  const workspace = (await workspaceResponse.json()) as { id: string }
  const orchestratorId = `${workspace.id}:orchestrator`
  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    }),
  })
  const startResponse = await fetch(
    `${server.baseUrl}/api/workspaces/${workspace.id}/agents/${orchestratorId}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ hive_port: server.baseUrl.split(':').at(-1) ?? '' }),
    }
  )
  expect(startResponse.status).toBe(201)
  const token = server.store.peekAgentToken(orchestratorId)
  if (!token) {
    throw new Error('Expected orchestrator token after start')
  }

  process.env = {
    ...originalEnv,
    HIVE_AGENT_ID: orchestratorId,
    HIVE_AGENT_TOKEN: token,
    HIVE_PORT: server.baseUrl.split(':').at(-1) ?? '',
    HIVE_PROJECT_ID: workspace.id,
  }

  await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'Alice', role: 'coder' }),
  })
})

afterEach(async () => {
  process.env = { ...originalEnv }
  await cleanupServer?.()
  cleanupServer = undefined
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('team send contract', () => {
  test('team send treats UUID-shaped input as a worker name and returns roster guidance when unknown', async () => {
    await expect(
      runTeamCommand(['send', '123e4567-e89b-12d3-a456-426614174000', 'Implement login'])
    ).rejects.toThrow('Unknown worker "123e4567-e89b-12d3-a456-426614174000"')
  })
})
