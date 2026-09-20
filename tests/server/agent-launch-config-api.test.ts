import { mkdirSync, mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Server[] = []
const stores: RuntimeStore[] = []

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })

afterEach(async () => {
  while (servers.length > 0) {
    await closeServer(servers.pop() as Server)
  }

  while (stores.length > 0) {
    await stores.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

describe('agent launch config api', () => {
  test('POST /api/workspaces/:id/agents/:agentId/config stores launch config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-launch-config-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)

    const store = createRuntimeStore({ dataDir })
    stores.push(store)
    const workspace = store.createWorkspace(workspacePath, 'Alpha')
    const orchestrator = store.getWorkspaceSnapshot(workspace.id).agents[0]
    if (!orchestrator) {
      throw new Error('Expected default orchestrator')
    }

    const app = createApp({ store })
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve())
    })
    servers.push(app.server)

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to an inet port')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const cookie = await getUiCookie(baseUrl)

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/agents/${orchestrator.id}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ command: 'node', args: ['script.js'] }),
      }
    )

    expect(response.status).toBe(204)
  })
})
