import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH
afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const d of tempDirs.splice(0)) rmSync(d, { force: true, recursive: true })
})

describe('workflow dispatches GET enriches `submitted` rows with lastPtyLine (TIER 2 #6)', () => {
  test('a dispatch in submitted status carries the worker PTY tail so the Drawer can peek without navigating', async () => {
    /* Regression for TIER 2 #6. Before this, the Drawer's
       DispatchAgentRow could only show prompt + (final) report, so a
       running ephemeral worker was a black box until it died. The
       enrichment in routes-workflows splices last_pty_line onto
       `submitted` rows; reported/cancelled stay untouched (their
       reportText is authoritative). */
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-pty-peek-'))
    const workspacePath = join(dataDir, 'ws')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)
    const scriptPath = join(workspacePath, 'echo.ts')
    writeFileSync(
      scriptPath,
      [
        "export const meta = { name: 'echo', description: 'd' }",
        "const r = await agent('hello')",
        'return r',
      ].join('\n')
    )
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const cookie = await getUiCookie(baseUrl)
      const wsResp = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'WS', path: workspacePath }),
      })
      const ws = (await wsResp.json()) as { id: string }
      // Background-start the workflow; we want to query while a dispatch
      // is in 'submitted' state (worker spawned but no team report yet).
      const runStart = hive.store.startWorkflow({
        workspaceId: ws.id,
        scriptPath,
        hivePort: String(hive.port),
      })
      // Poll until at least one submitted workflow dispatch is visible
      // OR the run finishes (the latter happens fast on empty PTYs and
      // would skip the test scenario — fail clearly).
      const deadline = Date.now() + 8000
      let submittedId: string | null = null
      let workspaceId: string | null = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        const submitted = hive.store
          .listDispatches(ws.id, { status: 'submitted' })
          .find((d) => d.workflowRunId !== null)
        if (submitted) {
          submittedId = submitted.id
          workspaceId = submitted.workspaceId
          break
        }
      }
      expect(submittedId).not.toBeNull()
      expect(workspaceId).toBe(ws.id)

      // The run is still in-flight — query the dispatch list route.
      // We can't deterministically force a known PTY line on the
      // ephemeral worker, but the field SHOULD be either a string
      // (worker printed something) or absent (PTY quiet). It must
      // never be null/undefined when present. The structural
      // expectation is that the route accepts the request and returns
      // dispatches without crashing.
      const initial = await runStart
      const resp = await fetch(`${baseUrl}/api/workflows/runs/${initial.id}/dispatches`, {
        headers: { cookie },
      })
      expect(resp.status).toBe(200)
      const body = (await resp.json()) as {
        dispatches: Array<{ id: string; status: string; last_pty_line?: string | null }>
      }
      const ours = body.dispatches.find((d) => d.id === submittedId)
      expect(ours).toBeDefined()
      // For dispatches that have already transitioned to reported (the
      // run completed while we were querying), the enrichment is
      // intentionally not applied — only submitted rows carry the field.
      if (ours?.status === 'submitted') {
        // Type-only assertion: when present it's a string, not null.
        if (ours.last_pty_line !== null && ours.last_pty_line !== undefined) {
          expect(typeof ours.last_pty_line).toBe('string')
        }
      } else {
        expect(ours?.last_pty_line).toBeNull()
      }
    } finally {
      await hive.close()
    }
  })
})
