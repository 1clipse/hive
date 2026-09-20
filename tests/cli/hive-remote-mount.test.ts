import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { runHiveCommand } from '../../src/cli/hive.js'
import {
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../../src/server/remote-config-keys.js'
import { openRuntimeDatabase } from '../../src/server/runtime-database.js'
import { createSettingsStore } from '../../src/server/settings-store.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'

// Mount tests: the tunnel is constructed inside runHiveCommand and GATED behind remote_enabled
// (default OFF). These run against a REAL `ws` fake gateway — no mocked socket, no mocked PTY.
// The point of each assertion is invariant 4 (off == zero behavior change): a default boot opens
// NO outbound connection; only flipping remote_enabled='true' arms the socket.

const TOKEN = 'daemon-token-mount'

const waitFor = async (
  pred: () => boolean,
  timeoutMs = 3000,
  label = 'condition'
): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Seed app_state in a fresh data dir BEFORE runHiveCommand boots, so the tunnel's first refresh()
// sees the config. The DB lives at <dataDir>/runtime.sqlite; we open it, write, close.
const seedRemoteConfig = (dataDir: string, values: Record<string, string | null>): void => {
  const db = openRuntimeDatabase(dataDir)
  const settings = createSettingsStore(db)
  for (const [key, value] of Object.entries(values)) settings.setAppState(key, value)
  db.close()
}

describe('hive runtime mount — remote tunnel gating (invariant 4)', () => {
  let gateway: FakeGateway
  const dataDirs: string[] = []
  let started: Awaited<ReturnType<typeof runHiveCommand>> | undefined

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    gateway = await startFakeGateway({ expectedToken: TOKEN })
  })

  afterEach(async () => {
    if (started) await started.close()
    started = undefined
    await gateway.close()
    delete process.env.HIVE_DATA_DIR
    for (const d of dataDirs.splice(0)) rmSync(d, { force: true, recursive: true })
    vi.restoreAllMocks()
  })

  const newDataDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'hive-mount-'))
    dataDirs.push(d)
    process.env.HIVE_DATA_DIR = d
    return d
  }

  test('default OFF: even with a gateway URL + token present, NO outbound connection is opened', async () => {
    const dataDir = newDataDir()
    // Creds present but remote_enabled is ABSENT (the default). A truthy-check bug would connect.
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
    })

    started = await runHiveCommand(['--port', '0'])

    // Give the tunnel a real window to (incorrectly) connect.
    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(0)
    expect(started.tunnel.status()).toBe('disabled')
  })

  test('remote_enabled !== "true" (e.g. "false") stays OFF — no connection', async () => {
    const dataDir = newDataDir()
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
      [REMOTE_ENABLED_KEY]: 'false',
    })

    started = await runHiveCommand(['--port', '0'])

    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(0)
    expect(started.tunnel.status()).toBe('disabled')
  })

  test('ON: remote_enabled="true" + token arms exactly one outbound connection with bearer.<token>', async () => {
    const dataDir = newDataDir()
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
      [REMOTE_ENABLED_KEY]: 'true',
    })

    started = await runHiveCommand(['--port', '0'])

    await gateway.waitForDaemon()
    await waitFor(() => started?.tunnel.status() === 'online', 3000, 'online')
    expect(gateway.connectionCount()).toBe(1)
    expect(gateway.lastDaemonProtocol()).toContain(`bearer.${TOKEN}`)
  })

  test('toggle ON at runtime via the store + tunnel.refresh() opens the connection', async () => {
    const dataDir = newDataDir()
    // Boot OFF (no enabled flag), then flip it on the live store and refresh — the Settings path.
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
    })

    started = await runHiveCommand(['--port', '0'])
    await new Promise((r) => setTimeout(r, 100))
    expect(gateway.connectionCount()).toBe(0)
    expect(started.tunnel.status()).toBe('disabled')

    started.store.settings.setAppState(REMOTE_ENABLED_KEY, 'true')
    started.tunnel.refresh()

    await gateway.waitForDaemon()
    await waitFor(() => started?.tunnel.status() === 'online', 3000, 'online after toggle')
    expect(gateway.connectionCount()).toBe(1)
  })

  test('close() tears the tunnel down — no reconnect after shutdown', async () => {
    const dataDir = newDataDir()
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
      [REMOTE_ENABLED_KEY]: 'true',
    })

    started = await runHiveCommand(['--port', '0'])
    await waitFor(() => started?.tunnel.status() === 'online', 3000, 'online')
    const countBefore = gateway.connectionCount()

    await started.close()
    started = undefined // already closed; afterEach must not double-close

    // No reconnect after a graceful close — give it a real window.
    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(countBefore)
  })

  test('off does not change auth: /api requires the UI cookie even with the tunnel wired', async () => {
    const dataDir = newDataDir()
    seedRemoteConfig(dataDir, {
      [REMOTE_GATEWAY_URL_KEY]: gateway.url,
      [REMOTE_DAEMON_TOKEN_KEY]: TOKEN,
      [REMOTE_DAEMON_ID_KEY]: 'd1',
      [REMOTE_ENABLED_KEY]: 'true',
    })

    started = await runHiveCommand(['--port', '0'])
    const baseUrl = `http://127.0.0.1:${started.port}`

    // No cookie, no per-boot secret → 403 (the cookie path is untouched by the mount).
    const noAuth = await fetch(`${baseUrl}/api/workspaces`)
    expect(noAuth.status).toBe(403)

    // A forged secret header on a direct 127.0.0.1 request must NOT get tunnel privileges.
    const forged = await fetch(`${baseUrl}/api/workspaces`, {
      headers: { 'x-hive-remote-secret': 'not-the-real-secret' },
    })
    expect(forged.status).toBe(403)
  })
})
