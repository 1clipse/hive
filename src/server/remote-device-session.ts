import type { Direction } from '../shared/remote-crypto.js'

// The seam M4 (device pairing) fills. The tunnel/bridge looks up a device's M1 directional session
// keys by deviceId; M3 ships the in-memory implementation (tests inject a key), M4 wires the
// pairing-backed one that refreshes on every (re)handshake/revoke.
//
// deviceId is NEVER read from a clear-text frame field — it is only ever the result of successfully
// OPENING a frame with a candidate key (invariant 5). This provider just maps a resolved deviceId to
// its keys; it makes no trust decision of its own.

export interface DeviceSession {
  deviceId: string
  /**
   * 32-byte directional ROOT keys from M1 deriveDaemonSession. M6.1: these are ROOTS — the bridge
   * derives the per-connection AEAD keys from them via deriveConnectionKeys + the bilateral connection
   * salts, and seals/opens ONLY under those connKeys. These bytes are NEVER passed to sealNext/openNext
   * directly; that is what makes resetting seq to 0 per connection safe (the AEAD key is fresh per
   * connection even though the root is persisted/reused).
   */
  keys: { d2p: Uint8Array; p2d: Uint8Array }
}

export interface DeviceSessionProvider {
  /**
   * null => unknown / revoked / no established session. The tunnel resets the stream and audits
   * 'no_session'; it never bridges a frame for a device it has no key for.
   */
  get(deviceId: string): DeviceSession | null
  /**
   * Every established session. Used ONLY to resolve which device a CHANNEL_STREAM_ID Hello came
   * from: the relay does not tag the source device, so the daemon trial-opens the Hello against
   * each candidate's p2d key until one authenticates (AEAD makes a wrong key fail cleanly). After
   * the Hello opens, the daemon binds (deviceId, streamId)->device and never trial-opens that
   * stream again. deviceId is therefore only ever the result of a successful open (invariant 5).
   */
  candidates(): DeviceSession[]
}

// Daemon directions — the mirror of the device's. Exported so the tunnel, the bridge and the tests
// all agree on ONE source of truth for which key opens/seals which way.
//   - the daemon OPENS inbound phone→daemon frames with p2d
//   - the daemon SEALS outbound daemon→phone frames with d2p
export const DAEMON_OPEN_DIRECTION: Direction = 'p2d'
export const DAEMON_SEAL_DIRECTION: Direction = 'd2p'

export class InMemoryDeviceSessionProvider implements DeviceSessionProvider {
  private readonly sessions = new Map<string, DeviceSession>()

  set(session: DeviceSession): void {
    this.sessions.set(session.deviceId, session)
  }

  /** Models a revoke: the key is gone, so the next frame for this device fails 'no_session'. */
  remove(deviceId: string): void {
    this.sessions.delete(deviceId)
  }

  get(deviceId: string): DeviceSession | null {
    return this.sessions.get(deviceId) ?? null
  }

  candidates(): DeviceSession[] {
    return [...this.sessions.values()]
  }
}
