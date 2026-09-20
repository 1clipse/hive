// Remote-access config lives in the existing app_state KV. These are the
// canonical key literals — the single source of truth for BOTH sides of the
// feature: `hive remote login/logout` (src/cli/hive-remote.ts) writes them, and
// the daemon-side tunnel reads them. The CLI re-exports these so there is one
// definition, not two that can drift (a rename on only one side would silently
// stop login from reaching the tunnel).
//
// snake_case to match the existing app_state keys (active_workspace_id, …).
// Every key registered here is automatically denylisted on the HTTP app-state
// route for tunnel-origin traffic (and remote_enabled writes from any origin).
const remoteConfigKeys = new Set<string>()
const remoteConfigKey = <T extends string>(value: T): T => {
  remoteConfigKeys.add(value)
  return value
}

export const REMOTE_GATEWAY_URL_KEY = remoteConfigKey('remote_gateway_url')
export const REMOTE_DAEMON_TOKEN_KEY = remoteConfigKey('remote_daemon_token')
export const REMOTE_DAEMON_ID_KEY = remoteConfigKey('remote_daemon_id')
export const REMOTE_ENABLED_KEY = remoteConfigKey('remote_enabled')
export const REMOTE_PENDING_REVOKES_KEY = remoteConfigKey('remote_pending_revokes')

export const isRemoteConfigKey = (key: string): boolean => remoteConfigKeys.has(key)
export const listRemoteConfigKeys = (): string[] => [...remoteConfigKeys]

export const DEFAULT_GATEWAY_URL = 'https://app.hivehq.dev'

// remote_enabled is ON only when it is exactly the string 'true'. Everything
// else — absent, '', 'false', '1', 'yes' — is OFF. This is invariant 4 (off ==
// zero behavior change): a truthy check would let a stray value silently arm
// the outbound tunnel, so the test pins the exact-string semantics.
const ENABLED_VALUE = 'true'

// The minimal read surface this helper needs. Both createAppStateStore (which
// returns { key, value }) and the CLI's RemoteConfigStore satisfy it, so the
// same source works in-daemon and in the one-shot CLI.
export interface RemoteAppStateReader {
  get(key: string): { value: string | null } | undefined
}

// Daemon-side view of the remote config. Reads are live: every call hits the
// store, so a `hive remote logout` (which clears the token) is observed by the
// tunnel's next refresh() without any cache to invalidate.
export interface RemoteConfigSource {
  isEnabled(): boolean
  getGatewayUrl(): string | null
  getDaemonToken(): string | null
  getDaemonId(): string | null
}

export const createRemoteConfigSource = (store: RemoteAppStateReader): RemoteConfigSource => {
  const read = (key: string): string | null => store.get(key)?.value ?? null
  return {
    isEnabled: () => read(REMOTE_ENABLED_KEY) === ENABLED_VALUE,
    getGatewayUrl: () => read(REMOTE_GATEWAY_URL_KEY),
    getDaemonToken: () => read(REMOTE_DAEMON_TOKEN_KEY),
    getDaemonId: () => read(REMOTE_DAEMON_ID_KEY),
  }
}
