// Persistent (per gateway origin) record of a paired device's DURABLE identity. Owned by the pairing
// client; TunnelTransport's silent-rebuild reads it on page refresh to rebuild a session.
//
// What is stored (localStorage, gateway origin):
//   - the device X25519 keypair (serialized base64url) — the long-lived phone identity
//   - the daemon's PUBLIC key (base64url) — public, safe at rest
//   - the directional ROOT keys d2p/p2d (base64url) — see below
//   - the ids + protocol version + pairedAt
//
// M6.1: the phone MUST persist the directional ROOT (`rootKeys`). The root is derived once at pairing
// from `deriveDeviceSession({ pairingSecret, sessionSalt, … })`; both the pairingSecret and the salt are
// one-time and wiped after the ceremony, so the phone CANNOT re-derive the root on reload. Mirroring the
// daemon (which persists the root in SQLite), the phone stores it. The root is NEVER an AEAD key: every
// (re)connect draws a fresh bilateral connection salt and the bridge/mux derive the per-connection AEAD
// keys via deriveConnectionKeys, so a reload with the same root still gets fresh keys (seq=0 stays safe).
//
// What is NEVER stored (invariant 3):
//   - pairingSecret (one-time; lives only in the QR, used once during the ceremony)
//   - the per-connection AEAD connKeys (ephemeral; re-derived per connect from the root + fresh salts)
//   - hive_ui_token (the virtual cookie jar's concern, in-memory only)
//   - the gateway phone JWT (an HttpOnly cookie the browser replays to the gateway origin on its own)

// Bumped v1 -> v2 with M6.1 (the record gained rootKeys). The prefix carries the version so a stale v1
// record under the OLD prefix is simply abandoned (different key) — and load() also wipes any v1 record
// it stumbles on so a dead, identity-bearing keypair doesn't linger at rest.
const KEY_PREFIX = 'hive.device-session.v2'
const LEGACY_KEY_PREFIX = 'hive.device-session.v1'

export interface StoredDeviceSession {
  v: 2
  gatewayUrl: string
  daemonId: string
  deviceId: string
  // serializeDeviceKeyPair output — the durable identity (base64url secret + public).
  deviceKeyPair: { secretKey: string; publicKey: string }
  // base64url, PUBLIC only.
  daemonPublicKey: string
  // base64url directional ROOT keys. Fed to deriveConnectionKeys per connect; never an AEAD key directly.
  rootKeys: { d2p: string; p2d: string }
  protocolVersion: number
  pairedAt: number
}

export interface DeviceSessionStore {
  load(gatewayUrl: string, daemonId: string): StoredDeviceSession | null
  save(rec: StoredDeviceSession): void
  clear(gatewayUrl: string, daemonId: string): void
}

const storageKey = (gatewayUrl: string, daemonId: string): string =>
  `${KEY_PREFIX}:${gatewayUrl}:${daemonId}`

const legacyStorageKey = (gatewayUrl: string, daemonId: string): string =>
  `${LEGACY_KEY_PREFIX}:${gatewayUrl}:${daemonId}`

const isStored = (raw: unknown): raw is StoredDeviceSession => {
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Record<string, unknown>
  if (o.v !== 2) return false
  if (typeof o.gatewayUrl !== 'string' || typeof o.daemonId !== 'string') return false
  if (typeof o.deviceId !== 'string' || typeof o.daemonPublicKey !== 'string') return false
  if (typeof o.protocolVersion !== 'number' || typeof o.pairedAt !== 'number') return false
  const kp = o.deviceKeyPair
  if (typeof kp !== 'object' || kp === null) return false
  const k = kp as Record<string, unknown>
  if (typeof k.secretKey !== 'string' || typeof k.publicKey !== 'string') return false
  const rk = o.rootKeys
  if (typeof rk !== 'object' || rk === null) return false
  const r = rk as Record<string, unknown>
  return typeof r.d2p === 'string' && typeof r.p2d === 'string'
}

// A localStorage-backed store. SSR / no-storage environments degrade to a no-op load (null) rather
// than throwing — the pairing client treats a null load as "not paired for this daemon".
export const createDeviceSessionStore = (
  backing: Storage | null = globalThis.localStorage ?? null
): DeviceSessionStore => ({
  load: (gatewayUrl, daemonId) => {
    if (!backing) return null
    // Wipe any pre-M6.1 v1 record so a dead, identity-bearing keypair doesn't linger at rest. A v1
    // record is non-recoverable (no rootKeys) — the only correct outcome is re-pair, so drop it.
    if (backing.getItem(legacyStorageKey(gatewayUrl, daemonId)) !== null) {
      backing.removeItem(legacyStorageKey(gatewayUrl, daemonId))
    }
    const raw = backing.getItem(storageKey(gatewayUrl, daemonId))
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      return isStored(parsed) ? parsed : null
    } catch {
      return null
    }
  },
  save: (rec) => {
    if (!backing) return
    backing.setItem(storageKey(rec.gatewayUrl, rec.daemonId), JSON.stringify(rec))
  },
  clear: (gatewayUrl, daemonId) => {
    if (!backing) return
    backing.removeItem(storageKey(gatewayUrl, daemonId))
  },
})
