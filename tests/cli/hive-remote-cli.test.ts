import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import {
  type DaemonTokenResponse,
  type GatewayClient,
  HIVE_REMOTE_USAGE,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
  type RemoteConfigStore,
  type RemoteDeviceListStore,
  runHiveRemoteCommand,
} from '../../src/cli/hive-remote.js'
import { createAppStateStore } from '../../src/server/app-state-store.js'
import { REMOTE_PENDING_REVOKES_KEY } from '../../src/server/remote-config-keys.js'
import {
  createRemoteDeviceStore,
  type RemoteDeviceRecord,
} from '../../src/server/remote-device-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

// In-memory device store stand-in (the CLI's `devices`/`revoke` read/write the
// LOCAL device store, not the gateway). list() filters revoked unless asked;
// revoke() is idempotent and returns false for unknown/already-revoked — exactly
// the createRemoteDeviceStore contract the CLI depends on.
const makeDeviceStore = (initial: RemoteDeviceRecord[] = []) => {
  const rows = initial.map((r) => ({ ...r }))
  const store: RemoteDeviceListStore = {
    list: (includeRevoked = false) =>
      rows.filter((r) => includeRevoked || r.revokedAt === null).map((r) => ({ ...r })),
    revoke: (deviceId, now = 1) => {
      const row = rows.find((r) => r.id === deviceId)
      if (!row || row.revokedAt !== null) return false
      row.revokedAt = now
      return true
    },
  }
  return { store, rows }
}

const device = (over: Partial<RemoteDeviceRecord> & { id: string }): RemoteDeviceRecord => ({
  name: over.id,
  createdAt: 1_700_000_000_000,
  lastActive: null,
  revokedAt: null,
  ...over,
})

// In-memory app_state stand-in matching the { value } shape the CLI reads.
const makeConfig = (initial: Record<string, string> = {}): RemoteConfigStore => {
  const map = new Map<string, string | null>(Object.entries(initial))
  return {
    get: (key) => (map.has(key) ? { value: map.get(key) ?? null } : undefined),
    set: (key, value) => {
      map.set(key, value)
    },
  }
}

interface FakeGatewayOptions {
  /** Number of /daemon/token polls that return null (pending) before success. */
  pendingPolls?: number
  token?: DaemonTokenResponse
  expiresAt?: number
}

const makeGateway = (options: FakeGatewayOptions = {}) => {
  const calls: string[] = []
  let polls = 0
  const token = options.token ?? { daemonId: 'daemon-1', daemonToken: 'hd_secret' }
  const client: GatewayClient = {
    async requestCode() {
      calls.push('requestCode')
      return { code: 'hc_code', expiresAt: options.expiresAt ?? 10_000, pollIntervalMs: 1 }
    },
    async exchangeToken(_url, _code) {
      calls.push('exchangeToken')
      if (polls < (options.pendingPolls ?? 0)) {
        polls += 1
        return null
      }
      return token
    },
  }
  return { client, calls }
}

const collect = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
    out,
    err,
  }
}

describe('hive remote — help / dispatch', () => {
  test('no subcommand prints usage and exits 1', async () => {
    const sink = collect()
    const code = await runHiveRemoteCommand([], { log: sink.log, error: sink.error })
    expect(code).toBe(1)
    expect(sink.out.join('\n')).toBe(HIVE_REMOTE_USAGE)
  })

  test('--help prints usage and exits 0', async () => {
    const sink = collect()
    const code = await runHiveRemoteCommand(['--help'], { log: sink.log, error: sink.error })
    expect(code).toBe(0)
    expect(sink.out.join('\n')).toBe(HIVE_REMOTE_USAGE)
  })

  test('unknown subcommand exits 1 without touching the config store', async () => {
    const sink = collect()
    // No `config` injected: if the dispatcher tried to open the runtime DB this
    // would throw on a sandbox without a data dir. It must reject before that.
    const code = await runHiveRemoteCommand(['frobnicate'], { log: sink.log, error: sink.error })
    expect(code).toBe(1)
    expect(sink.err.join('\n')).toContain('Unknown remote subcommand: frobnicate')
  })
})

describe('hive remote login', () => {
  test('stores gateway url + token + enabled after approval', async () => {
    const config = makeConfig()
    const gateway = makeGateway({ token: { daemonId: 'daemon-9', daemonToken: 'hd_live' } })
    const sink = collect()

    const code = await runHiveRemoteCommand(['login', '--gateway', 'https://gw.test'], {
      config,
      client: gateway.client,
      log: sink.log,
      error: sink.error,
      sleep: async () => {},
    })

    expect(code).toBe(0)
    expect(config.get(REMOTE_GATEWAY_URL_KEY)?.value).toBe('https://gw.test')
    expect(config.get(REMOTE_DAEMON_ID_KEY)?.value).toBe('daemon-9')
    expect(config.get(REMOTE_DAEMON_TOKEN_KEY)?.value).toBe('hd_live')
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('true')
  })

  test('prints the approval URL and code, but never the daemon token', async () => {
    const config = makeConfig()
    const gateway = makeGateway({ token: { daemonId: 'd', daemonToken: 'hd_TOPSECRET' } })
    const sink = collect()

    await runHiveRemoteCommand(['login', '--gateway', 'https://gw.test'], {
      config,
      client: gateway.client,
      log: sink.log,
      error: sink.error,
      sleep: async () => {},
    })

    const printed = sink.out.join('\n')
    expect(printed).toContain('https://gw.test/daemon/approve?code=hc_code')
    expect(printed).toContain('Code: hc_code')
    // The token is local RCE; it must not leak to the terminal/logs.
    expect(printed).not.toContain('hd_TOPSECRET')
  })

  test('polls /daemon/token until approval flips the code', async () => {
    const config = makeConfig()
    const gateway = makeGateway({ pendingPolls: 3, expiresAt: 1_000_000 })
    const sink = collect()

    const code = await runHiveRemoteCommand(['login'], {
      config,
      client: gateway.client,
      log: sink.log,
      error: sink.error,
      // Hold the clock well before expiresAt so the loop polls, not times out.
      now: () => 0,
      sleep: async () => {},
    })

    expect(code).toBe(0)
    // 3 pending + 1 success.
    expect(gateway.calls.filter((c) => c === 'exchangeToken')).toHaveLength(4)
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('true')
  })

  test('gives up (exit 1) when the code expires before approval, leaving remote disabled', async () => {
    const config = makeConfig()
    // Always pending; the clock advances past expiresAt on the first check.
    const gateway = makeGateway({ pendingPolls: Number.POSITIVE_INFINITY, expiresAt: 5_000 })
    const sink = collect()
    let clock = 0

    const code = await runHiveRemoteCommand(['login'], {
      config,
      client: gateway.client,
      log: sink.log,
      error: sink.error,
      now: () => {
        clock += 10_000
        return clock
      },
      sleep: async () => {},
    })

    expect(code).toBe(1)
    expect(config.get(REMOTE_DAEMON_TOKEN_KEY)?.value ?? null).toBeNull()
    expect(config.get(REMOTE_ENABLED_KEY)?.value ?? null).not.toBe('true')
    expect(sink.out.join('\n')).toContain('expired')
  })

  test('falls back to the saved gateway url when --gateway is omitted', async () => {
    const config = makeConfig({ [REMOTE_GATEWAY_URL_KEY]: 'https://saved.test' })
    const gateway = makeGateway()
    const sink = collect()

    await runHiveRemoteCommand(['login'], {
      config,
      client: gateway.client,
      log: sink.log,
      error: sink.error,
      sleep: async () => {},
    })

    expect(sink.out.join('\n')).toContain('https://saved.test/daemon/approve')
  })
})

describe('hive remote status', () => {
  test('reports disabled + not-logged-in on a fresh config', async () => {
    const sink = collect()
    const code = await runHiveRemoteCommand(['status'], {
      config: makeConfig(),
      log: sink.log,
      error: sink.error,
    })
    expect(code).toBe(0)
    const printed = sink.out.join('\n')
    expect(printed).toContain('Remote access: disabled')
    expect(printed).toContain('Logged in: no')
  })

  test('reports enabled + logged-in + gateway, never the token', async () => {
    const sink = collect()
    const config = makeConfig({
      [REMOTE_ENABLED_KEY]: 'true',
      [REMOTE_GATEWAY_URL_KEY]: 'https://gw.test',
      [REMOTE_DAEMON_ID_KEY]: 'daemon-3',
      [REMOTE_DAEMON_TOKEN_KEY]: 'hd_secret_status',
    })

    await runHiveRemoteCommand(['status'], { config, log: sink.log, error: sink.error })

    const printed = sink.out.join('\n')
    expect(printed).toContain('Remote access: enabled')
    expect(printed).toContain('Logged in: yes')
    expect(printed).toContain('Gateway: https://gw.test')
    expect(printed).toContain('Machine id: daemon-3')
    expect(printed).not.toContain('hd_secret_status')
  })
})

describe('hive remote logout', () => {
  test('clears the token + machine id and disables remote', async () => {
    const config = makeConfig({
      [REMOTE_ENABLED_KEY]: 'true',
      [REMOTE_GATEWAY_URL_KEY]: 'https://gw.test',
      [REMOTE_DAEMON_ID_KEY]: 'daemon-3',
      [REMOTE_DAEMON_TOKEN_KEY]: 'hd_secret',
    })
    const sink = collect()

    const code = await runHiveRemoteCommand(['logout'], {
      config,
      log: sink.log,
      error: sink.error,
    })

    expect(code).toBe(0)
    expect(config.get(REMOTE_DAEMON_TOKEN_KEY)?.value ?? null).toBeNull()
    expect(config.get(REMOTE_DAEMON_ID_KEY)?.value ?? null).toBeNull()
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('false')
  })
})

describe('hive remote devices', () => {
  test('lists paired devices from the local store, incl. revoked', async () => {
    const sink = collect()
    const { store } = makeDeviceStore([
      device({ id: 'dev-1', name: 'iPhone', lastActive: 1_700_000_000_000 }),
      device({ id: 'dev-2', name: 'Pixel', lastActive: null, revokedAt: 1_700_000_500_000 }),
    ])

    const code = await runHiveRemoteCommand(['devices'], {
      deviceStore: store,
      log: sink.log,
      error: sink.error,
    })

    expect(code).toBe(0)
    const printed = sink.out.join('\n')
    expect(printed).toContain('dev-1')
    expect(printed).toContain('iPhone')
    expect(printed).toContain('dev-2')
    expect(printed).toContain('(revoked)')
  })

  test('says none when the store is empty (no gateway, no login needed)', async () => {
    const sink = collect()
    const { store } = makeDeviceStore()
    const code = await runHiveRemoteCommand(['devices'], {
      deviceStore: store,
      log: sink.log,
      error: sink.error,
    })
    expect(code).toBe(0)
    expect(sink.out.join('\n')).toContain('No paired devices')
  })
})

describe('hive remote revoke', () => {
  const databases: Database[] = []
  afterEach(() => {
    while (databases.length) databases.pop()?.close()
  })
  const makeRevokeStore = (id: string) => {
    const db = new Database(':memory:')
    databases.push(db)
    initializeRuntimeDatabase(db)
    const store = createRemoteDeviceStore(db)
    store.insert({
      id,
      name: id,
      keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
      devicePublicKey: new Uint8Array(32).fill(3),
    })
    const config: RemoteConfigStore = {
      ...createAppStateStore(db),
      transaction: (mutation) => db.transaction(mutation)(),
    }
    return { store, config }
  }

  test('requires a deviceId', async () => {
    const sink = collect()
    const { store, config } = makeRevokeStore('dev-1')
    const code = await runHiveRemoteCommand(['revoke'], {
      deviceStore: store,
      config,
      log: sink.log,
      error: sink.error,
    })
    expect(code).toBe(1)
    expect(store.get('dev-1')?.revokedAt).toBeNull() // nothing revoked
    expect(sink.err.join('\n')).toContain('Usage: hive remote revoke <deviceId>')
  })

  test('errors on an unknown device', async () => {
    const sink = collect()
    const { store, config } = makeRevokeStore('dev-1')
    const code = await runHiveRemoteCommand(['revoke', 'nope'], {
      deviceStore: store,
      config,
      log: sink.log,
      error: sink.error,
    })
    expect(code).toBe(1)
    expect(sink.err.join('\n')).toContain('Unknown or already-revoked device')
  })

  test('revokes the named device in the local store', async () => {
    const sink = collect()
    const { store, config } = makeRevokeStore('dev-42')

    const code = await runHiveRemoteCommand(['revoke', 'dev-42'], {
      deviceStore: store,
      config,
      log: sink.log,
      error: sink.error,
    })

    expect(code).toBe(0)
    expect(store.get('dev-42')?.revokedAt).toEqual(expect.any(Number)) // the store row is actually revoked
    expect(sink.out.join('\n')).toContain('Revoked device dev-42')
    expect(store.getLiveSession('dev-42')).toBeNull()
    expect(JSON.parse(config.get(REMOTE_PENDING_REVOKES_KEY)?.value ?? 'null')).toEqual([
      { deviceId: 'dev-42', gatewayUrl: null },
    ])
  })
})

describe('hive remote dispatch (real subprocess)', () => {
  // Pin the full chain `process.argv → src/cli/hive.ts dispatch →
  // runHiveRemoteCommand`. Uses `remote --help` so it needs neither the runtime
  // DB nor the network — it just proves typing `hive remote ...` reaches the new
  // subcommand instead of falling through to `runHiveCommand` (which would try
  // to bind a port).
  test('`hive remote --help` exits 0 with the remote usage on stdout', async () => {
    const nodeRequire = createRequire(import.meta.url)
    const tsxCli = join(dirname(nodeRequire.resolve('tsx')), 'cli.mjs')
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, 'src/cli/hive.ts', 'remote', '--help'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        )
      }
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hive remote login')
    expect(result.stdout).toContain('hive remote revoke <deviceId>')
    // Remote help must NOT print the generic `hive` usage with `--port`.
    expect(result.stdout).not.toContain('--port <port>')
  })
})
