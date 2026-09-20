import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import { localDayKey, type RetentionSignals } from '../../src/server/protocol-event-stats.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { getUiCookie } from '../helpers/ui-session.js'
import { prependPassiveWorkflowCliPath } from '../helpers/workflow-fake-cli.js'

const tempDirs: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  delete process.env.HIVE_DATA_DIR
  process.env.PATH = originalPath
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

describe('local retention signals (issue #23)', () => {
  test('protocol events bump the per-day counters readable at /api/diagnostics/retention', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-retention-'))
    const workspacePath = join(dataDir, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    tempDirs.push(dataDir)
    const passiveScript = join(workspacePath, 'passive.js')
    writeFileSync(passiveScript, "process.stdin.setEncoding('utf8'); process.stdin.resume();\n")
    prependPassiveWorkflowCliPath(dataDir, ['claude'], originalPath)

    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const baseUrl = `http://127.0.0.1:${hive.port}`
      const uiCookie = await getUiCookie(baseUrl)

      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ autostart_orchestrator: false, name: 'Alpha', path: workspacePath }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ name: 'Alice', role: 'coder' }),
      })
      const worker = (await workerResponse.json()) as { id: string }
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: process.execPath, args: [passiveScript] }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: String(hive.port) }),
      })

      const before = await fetch(`${baseUrl}/api/diagnostics/retention`, {
        headers: { cookie: uiCookie },
      })
      expect(before.status).toBe(200)
      const baseline = (await before.json()) as RetentionSignals

      const dispatch = await hive.store.dispatchTaskByWorkerName(
        workspace.id,
        'Alice',
        'implement login',
        { fromAgentId: `${workspace.id}:orchestrator`, hivePort: String(hive.port) }
      )
      hive.store.reportTask(workspace.id, worker.id, { text: 'done', dispatchId: dispatch.id })

      const after = await fetch(`${baseUrl}/api/diagnostics/retention`, {
        headers: { cookie: uiCookie },
      })
      expect(after.status).toBe(200)
      const signals = (await after.json()) as RetentionSignals
      expect(signals.totals.send).toBe(baseline.totals.send + 1)
      expect(signals.totals.report).toBe(baseline.totals.report + 1)
      expect(signals.current_streak_days).toBeGreaterThanOrEqual(1)
      expect(signals.first_event_day).toBe(localDayKey(Date.now()))
      const today = signals.daily.find((row) => row.day === localDayKey(Date.now()))
      expect(today?.send).toBeGreaterThanOrEqual(1)
      expect(today?.report).toBeGreaterThanOrEqual(1)

      // The shareable support bundle carries the same counters (counts only).
      const bundle = await fetch(`${baseUrl}/api/diagnostics/support-bundle`, {
        headers: { cookie: uiCookie },
      })
      const bundleBody = (await bundle.json()) as {
        app: {
          can_run_hive_update: boolean
          install_hint: string
          install_source: string
          update_note: string
        }
        retention: RetentionSignals
      }
      expect(bundleBody.retention.totals.send).toBe(signals.totals.send)
      expect(bundleBody.app).toEqual(
        expect.objectContaining({
          can_run_hive_update: expect.any(Boolean),
          install_hint: expect.any(String),
          install_source: expect.any(String),
          update_note: expect.any(String),
        })
      )
    } finally {
      await hive.close()
    }
  }, 20_000)

  test('retention endpoint requires a UI session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-retention-auth-'))
    tempDirs.push(dataDir)
    process.env.HIVE_DATA_DIR = dataDir
    const hive = await runHiveCommand(['--port', '0'])
    try {
      const response = await fetch(`http://127.0.0.1:${hive.port}/api/diagnostics/retention`)
      // requireUiTokenFromRequest rejects missing sessions with 403 (same as
      // the support-bundle route).
      expect(response.status).toBe(403)
    } finally {
      await hive.close()
    }
  })
})
