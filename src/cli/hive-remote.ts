import { createAppStateStore } from '../server/app-state-store.js'
import { getMachineName } from '../server/machine-name.js'
import {
  DEFAULT_GATEWAY_URL,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from '../server/remote-config-keys.js'
import { createRemoteDeviceStore, type RemoteDeviceRecord } from '../server/remote-device-store.js'
import { postPairRevoke } from '../server/remote-gateway-client.js'
import {
  addPendingRevoke,
  getPendingRevokeGateway,
  type PendingRevokesStore,
  removePendingRevoke,
} from '../server/remote-pending-revokes.js'
import { openRuntimeDatabase } from '../server/runtime-database.js'
import type { Database } from '../server/sqlite.js'
import { resolveDataDir } from './hive-data-dir.js'

// Re-export so existing callers (and the CLI tests) can keep importing the keys
// from here; the canonical definitions live in remote-config-keys.ts, shared
// with the daemon-side tunnel so the on-disk contract can't drift between sides.
export {
  DEFAULT_GATEWAY_URL,
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
}

// `hive remote` — manage the daemon's connection to the remote-access gateway.
//
//   hive remote login [--gateway <url>]   bind this machine to a Hive account
//   hive remote status                    show connection + enabled state
//   hive remote logout                    forget the gateway token, disable remote
//   hive remote devices                   list paired phones/devices
//   hive remote revoke <deviceId>         revoke a paired device
//
// login drives the gateway's daemon-binding flow (gateway/src/daemon.ts):
//   POST /daemon/code  -> { code, expiresAt, pollIntervalMs }   (print URL + code)
//   ... human approves in their logged-in browser at /daemon/approve?code=... ...
//   POST /daemon/token -> 401 not_approved (keep polling) | 200 { daemonId, daemonToken }
//
// The token is account-scoped and is local RCE on this machine, so it lands in
// app_state (the same SQLite the daemon reads) and is NEVER printed back.
// `enabled` defaults OFF for the whole subsystem; a successful login flips it on.
// Off == zero behavior change: no token, no outbound tunnel (see remote-tunnel).

export const HIVE_REMOTE_USAGE = [
  'Usage:',
  '  hive remote login [--gateway <url>]   Link this machine to your Hive account.',
  '  hive remote status                    Show remote-access connection state.',
  '  hive remote logout                    Forget the gateway token and disable remote.',
  '  hive remote devices                   List paired devices.',
  '  hive remote revoke <deviceId>         Revoke a paired device.',
  '',
  'Remote access lets you reach this Hive from a phone through the gateway over',
  'an end-to-end encrypted tunnel. It is OFF until you log in, and `logout`',
  'turns it off again. The gateway only relays ciphertext — it never sees your',
  'data or terminals.',
  '',
  'Options:',
  `  --gateway <url>   Gateway base URL (default: ${DEFAULT_GATEWAY_URL}).`,
  '  -h, --help        Print this help.',
].join('\n')

// ── injectable config access (app_state) ─────────────────────────────────────
// The CLI runs as a one-shot process, not inside the daemon, so it opens the
// runtime DB directly. Tests inject an in-memory store to avoid disk + the real
// schema bootstrap.
export interface RemoteConfigStore {
  get(key: string): { value: string | null } | undefined
  set(key: string, value: string | null): void
  /** Required for revocation; must cover this config and the paired device store. */
  transaction?<T>(mutation: () => T): T
}

const createRemoteConfigStore = (db: Database): RemoteConfigStore => ({
  ...createAppStateStore(db),
  transaction: (mutation) => db.transaction(mutation)(),
})

const openConfigStore = (): { store: RemoteConfigStore; close: () => void } => {
  const db = openRuntimeDatabase(resolveDataDir())
  return { store: createRemoteConfigStore(db), close: () => db.close() }
}

const readConfig = (store: RemoteConfigStore, key: string): string | null =>
  store.get(key)?.value ?? null

// The CLI's RemoteConfigStore and the daemon's settings store are the SAME
// app_state table; adapt the accessor names so both sides share one durable
// revoke-queue module (remote-pending-revokes.ts).
const asPendingRevokesStore = (config: RemoteConfigStore): PendingRevokesStore => {
  const transaction = config.transaction
  if (!transaction) throw new TypeError('Remote revocation requires transactional storage')
  return {
    getAppState: (key) => config.get(key),
    setAppState: (key, value) => config.set(key, value),
    transaction: (mutation) => transaction(mutation),
  }
}

// ── injectable device store (local SQLite, the source of truth) ──────────────
// `devices` / `revoke` operate on the daemon's OWN persistent device store — the
// rows that hold each paired device's session keys (src/server/remote-device-store.ts).
// That is the source of truth: revoking here is what actually stops the daemon from
// opening that device's frames. (The gateway's copy is secondary; a gateway-only
// revoke would leave the local key live.) The CLI opens the same runtime DB the
// daemon reads, mirroring how login/status touch app_state.
export interface RemoteDeviceListStore {
  list(includeRevoked?: boolean): RemoteDeviceRecord[]
  /** Idempotent; false if the device is unknown or already revoked. */
  revoke(deviceId: string, now?: number): boolean
}

const openDeviceStore = (): { store: RemoteDeviceListStore; close: () => void } => {
  const db = openRuntimeDatabase(resolveDataDir())
  return { store: createRemoteDeviceStore(db), close: () => db.close() }
}

// Both stores live in the SAME SQLite file, so `revoke` (which needs the device
// rows AND the app_state config + revoke queue) opens ONE connection for both —
// previously two connections were opened and only the last one closed.
const openRemoteStores = (): {
  devices: RemoteDeviceListStore
  config: RemoteConfigStore
  close: () => void
} => {
  const db = openRuntimeDatabase(resolveDataDir())
  return {
    devices: createRemoteDeviceStore(db),
    config: createRemoteConfigStore(db),
    close: () => db.close(),
  }
}

// ── gateway client seam ───────────────────────────────────────────────────────
// `login` drives the gateway's daemon-binding flow (/daemon/code + /daemon/token).
// Device list is local SQLite. Revoke writes the local store, best-effort POSTs
// /pair/revoke, and durably enqueues the gateway revoke first so a failed POST is
// retried by the running daemon on its next tunnel-online (CLI and daemon share
// the same queue). All login HTTP is funnelled through GatewayClient so tests run
// with a fake, no network.
export interface DaemonCodeResponse {
  code: string
  expiresAt: number
  pollIntervalMs: number
}

export interface DaemonTokenResponse {
  daemonId: string
  daemonToken: string
}

export interface GatewayClient {
  requestCode(gatewayUrl: string): Promise<DaemonCodeResponse>
  // null => still pending (gateway returned 401 not_approved); keep polling.
  exchangeToken(
    gatewayUrl: string,
    code: string,
    name?: string
  ): Promise<DaemonTokenResponse | null>
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

const postJson = async (url: string, body: unknown, token?: string): Promise<Response> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

// Default client: real fetch against the gateway. The contracts mirror
// gateway/src/daemon.ts exactly (field names, the 401 not_approved poll signal).
export const defaultGatewayClient: GatewayClient = {
  async requestCode(gatewayUrl) {
    const res = await postJson(`${trimSlash(gatewayUrl)}/daemon/code`, {})
    if (!res.ok) throw new Error(`gateway /daemon/code failed: ${res.status}`)
    const body = (await res.json()) as Partial<DaemonCodeResponse>
    if (typeof body.code !== 'string' || typeof body.expiresAt !== 'number') {
      throw new Error('gateway /daemon/code returned an unexpected response')
    }
    return {
      code: body.code,
      expiresAt: body.expiresAt,
      pollIntervalMs: typeof body.pollIntervalMs === 'number' ? body.pollIntervalMs : 2000,
    }
  },
  async exchangeToken(gatewayUrl, code, name) {
    const payload: Record<string, string> = { code }
    if (name) payload.name = name
    const res = await postJson(`${trimSlash(gatewayUrl)}/daemon/token`, payload)
    // 401 == not yet approved (or expired). 429 == the gateway throttled this poll. Both mean "keep
    // polling until the code's expiresAt" — a transient 429 mid-wait must NOT kill the login (the
    // gateway sizes the /daemon/token budget for the poll cadence, but we stay robust if it ever
    // trips). Any other non-2xx is a hard failure.
    if (res.status === 401 || res.status === 429) return null
    if (!res.ok) throw new Error(`gateway /daemon/token failed: ${res.status}`)
    const body = (await res.json()) as Partial<DaemonTokenResponse>
    if (typeof body.daemonId !== 'string' || typeof body.daemonToken !== 'string') {
      throw new Error('gateway /daemon/token returned an unexpected response')
    }
    return { daemonId: body.daemonId, daemonToken: body.daemonToken }
  },
}

// ── command runner ─────────────────────────────────────────────────────────────

export interface RunHiveRemoteOptions {
  /** Inject a fake gateway client (tests). */
  client?: GatewayClient
  /** Inject an in-memory config store (tests); defaults to the runtime DB. */
  config?: RemoteConfigStore
  /** Inject a device store (tests); defaults to the runtime DB's device store. */
  deviceStore?: RemoteDeviceListStore
  /** Inject a clock for poll-timeout tests. */
  now?: () => number
  /** Inject the poll delay so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>
  /** stdout sink (defaults to console.log). */
  log?: (line: string) => void
  /** stderr sink (defaults to console.error). */
  error?: (line: string) => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const readGatewayFlag = (argv: string[]): string | undefined => {
  const index = argv.indexOf('--gateway')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error('Usage: hive remote login [--gateway <url>]')
  }
  return value
}

const approveUrl = (gatewayUrl: string, code: string): string =>
  `${trimSlash(gatewayUrl)}/daemon/approve?code=${encodeURIComponent(code)}`

const runLogin = async (
  argv: string[],
  store: RemoteConfigStore,
  client: GatewayClient,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void
): Promise<number> => {
  const gatewayUrl =
    readGatewayFlag(argv) ?? readConfig(store, REMOTE_GATEWAY_URL_KEY) ?? DEFAULT_GATEWAY_URL

  const { code, expiresAt, pollIntervalMs } = await client.requestCode(gatewayUrl)

  log('To link this machine, open the approval page in a browser where you are')
  log('logged in to your Hive account, and confirm the code matches:')
  log('')
  log(`  ${approveUrl(gatewayUrl, code)}`)
  log('')
  log(`  Code: ${code}`)
  log('')
  log('Waiting for approval…')

  const machineName = getMachineName() ?? undefined

  // Poll until the human approves or the code expires. The gateway hands back
  // null (HTTP 401) until approval flips the code; we never bail early.
  for (;;) {
    const token = await client.exchangeToken(gatewayUrl, code, machineName)
    if (token) {
      store.set(REMOTE_GATEWAY_URL_KEY, gatewayUrl)
      store.set(REMOTE_DAEMON_ID_KEY, token.daemonId)
      store.set(REMOTE_DAEMON_TOKEN_KEY, token.daemonToken)
      store.set(REMOTE_ENABLED_KEY, 'true')
      log('')
      log('This machine is linked. Remote access is now enabled.')
      log('Restart the Hive runtime (or it will connect on next start) to bring')
      log('the tunnel online. Pair a phone from Settings → Remote access.')
      return 0
    }
    if (now() >= expiresAt) {
      log('')
      log('The login code expired before it was approved. Run `hive remote login` again.')
      return 1
    }
    await sleep(pollIntervalMs)
  }
}

const runStatus = (store: RemoteConfigStore, log: (line: string) => void): number => {
  const enabled = readConfig(store, REMOTE_ENABLED_KEY) === 'true'
  const gatewayUrl = readConfig(store, REMOTE_GATEWAY_URL_KEY)
  const daemonId = readConfig(store, REMOTE_DAEMON_ID_KEY)
  const loggedIn = readConfig(store, REMOTE_DAEMON_TOKEN_KEY) !== null

  log(`Remote access: ${enabled ? 'enabled' : 'disabled'}`)
  log(`Logged in: ${loggedIn ? 'yes' : 'no'}`)
  // The token is secret and is intentionally never printed.
  if (gatewayUrl) log(`Gateway: ${gatewayUrl}`)
  if (daemonId) log(`Machine id: ${daemonId}`)
  if (!loggedIn) log('Run `hive remote login` to link this machine.')
  return 0
}

const runLogout = (store: RemoteConfigStore, log: (line: string) => void): number => {
  const wasLoggedIn = readConfig(store, REMOTE_DAEMON_TOKEN_KEY) !== null
  store.set(REMOTE_DAEMON_TOKEN_KEY, null)
  store.set(REMOTE_DAEMON_ID_KEY, null)
  store.set(REMOTE_ENABLED_KEY, 'false')
  log(
    wasLoggedIn
      ? 'Logged out. Remote access is disabled and the gateway token has been forgotten.'
      : 'Not logged in. Remote access is disabled.'
  )
  return 0
}

const runDevices = (store: RemoteDeviceListStore, log: (line: string) => void): number => {
  const devices = store.list(true) // include revoked so the operator sees the full roster
  if (devices.length === 0) {
    log('No paired devices. Pair a phone from Settings → Remote access.')
    return 0
  }
  for (const device of devices) {
    const lastSeen = device.lastActive ? new Date(device.lastActive).toISOString() : 'never'
    const status = device.revokedAt ? ' (revoked)' : ''
    log(`${device.id}  ${device.name}  last active ${lastSeen}${status}`)
  }
  return 0
}

const runRevoke = async (
  deviceId: string | undefined,
  store: RemoteDeviceListStore,
  config: RemoteConfigStore,
  log: (line: string) => void,
  error: (line: string) => void
): Promise<number> => {
  if (!deviceId) {
    error('Usage: hive remote revoke <deviceId>')
    return 1
  }
  const pendingRevokes = asPendingRevokesStore(config)
  // The normal CLI path owns one SQLite connection for both stores. Commit
  // revocation and retry obligation together, including while logged out.
  const entry = pendingRevokes.transaction(() => {
    if (!store.revoke(deviceId)) return null
    return addPendingRevoke(pendingRevokes, deviceId)
  })
  if (!entry) {
    error(`Unknown or already-revoked device: ${deviceId}`)
    return 1
  }
  const gatewayUrl = getPendingRevokeGateway(pendingRevokes)
  const daemonToken = readConfig(config, REMOTE_DAEMON_TOKEN_KEY)
  if (gatewayUrl && daemonToken && gatewayUrl === entry.gatewayUrl) {
    let confirmed = false
    try {
      await postPairRevoke({ gatewayUrl, daemonToken }, deviceId)
      confirmed = true
    } catch {
      log('Gateway revocation was not confirmed; it remains queued for the next tunnel connection.')
    }
    // A DB acknowledgement failure must surface as a persistence error, not be
    // mislabeled as a failed HTTP request. Its transaction preserves the queue.
    if (confirmed) removePendingRevoke(pendingRevokes, entry)
  }
  // Local E2E keys are gone immediately. Gateway row/JWT die on the POST above
  // (or the durable retry).
  log(`Revoked device ${deviceId}. It is refused on its next connection.`)
  return 0
}

export const runHiveRemoteCommand = async (
  argv: string[],
  options: RunHiveRemoteOptions = {}
): Promise<number> => {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    const log = options.log ?? console.log
    log(HIVE_REMOTE_USAGE)
    return argv.length === 0 ? 1 : 0
  }

  const [subcommand, ...rest] = argv
  const client = options.client ?? defaultGatewayClient
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const log = options.log ?? console.log
  const error = options.error ?? console.error

  // Open stores lazily so --help / unknown subcommands don't touch the DB, and
  // always close EVERY owned handle (previously a single `close` slot was
  // overwritten per open, leaking all but the last connection).
  const ownedClosers: Array<() => void> = []
  const resolveStore = (): RemoteConfigStore => {
    if (options.config) return options.config
    const opened = openConfigStore()
    ownedClosers.push(opened.close)
    return opened.store
  }
  const resolveDeviceStore = (): RemoteDeviceListStore => {
    if (options.deviceStore) return options.deviceStore
    const opened = openDeviceStore()
    ownedClosers.push(opened.close)
    return opened.store
  }

  try {
    switch (subcommand) {
      case 'login':
        return await runLogin(rest, resolveStore(), client, now, sleep, log)
      case 'status':
        return runStatus(resolveStore(), log)
      case 'logout':
        return runLogout(resolveStore(), log)
      case 'devices':
        return runDevices(resolveDeviceStore(), log)
      case 'revoke': {
        // One runtime DB connection backs both stores when neither is injected.
        if (Boolean(options.deviceStore) !== Boolean(options.config)) {
          throw new TypeError(
            'Remote revocation requires both stores from the same transactional database'
          )
        }
        const stores =
          options.deviceStore && options.config
            ? { devices: options.deviceStore, config: options.config }
            : openRemoteStores()
        if ('close' in stores) ownedClosers.push(stores.close)
        // await: the finally block below closes the DB; without it the close ran
        // while runRevoke's gateway POST was still in flight.
        return await runRevoke(rest[0], stores.devices, stores.config, log, error)
      }
      default:
        error(`Unknown remote subcommand: ${subcommand}`)
        error(HIVE_REMOTE_USAGE)
        return 1
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    return 1
  } finally {
    for (const close of ownedClosers) close()
  }
}
