// @vitest-environment jsdom
//
// Phone-side device-session store (M6.1). The persisted record now carries the directional ROOT keys
// (StoredDeviceSession.rootKeys) so a page reload can reconstruct a TunnelSession.roots WITHOUT the
// one-time pairingSecret/sessionSalt (both wiped after pairing — the phone cannot re-derive). These
// tests prove:
//   - the stored root round-trips byte-for-byte and DRIVES deriveConnectionKeys (the consumer of the
//     reload path), so a connKey derived from the rehydrated root matches one derived from the live root;
//   - the record bumped v:1 -> v:2; a stale v:1 record is treated as absent (re-pair) AND wiped from
//     localStorage so a dead identity-bearing keypair doesn't linger (HARDEN minor: stale-keypair leak);
//   - the KEY_PREFIX bump means v1 and v2 records live under different keys (old records abandoned cleanly).

import { describe, expect, test } from 'vitest'

import {
  deriveConnectionKeys,
  fromBase64Url,
  generateConnSalt,
  type HandshakeIds,
  REMOTE_CRYPTO_VERSION,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'
import {
  createDeviceSessionStore,
  type StoredDeviceSession,
} from '../../web/src/transport/device-session-store.js'

// A throwaway in-memory Storage so each test is isolated from jsdom's shared localStorage.
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

const GW = 'https://app.hivehq.dev'
const DAEMON = 'daemon-xyz'
const DEVICE = 'device-abc'

// Recognisable, non-trivial root bytes so a truncation / wrong-field bug surfaces byte-for-byte.
const rootD2p = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 11) & 0xff)
const rootP2d = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff)

const v2Record = (): StoredDeviceSession => ({
  v: 2,
  gatewayUrl: GW,
  daemonId: DAEMON,
  deviceId: DEVICE,
  deviceKeyPair: {
    secretKey: toBase64Url(new Uint8Array(32).fill(9)),
    publicKey: toBase64Url(new Uint8Array(32).fill(8)),
  },
  daemonPublicKey: toBase64Url(new Uint8Array(32).fill(7)),
  protocolVersion: REMOTE_CRYPTO_VERSION,
  pairedAt: 1700000000000,
  rootKeys: { d2p: toBase64Url(rootD2p), p2d: toBase64Url(rootP2d) },
})

describe('device-session-store (M6.1 root persistence)', () => {
  // S1 — the stored root round-trips byte-for-byte through save/load.
  test('save then load returns the rootKeys byte-equal to the input', () => {
    const store = createDeviceSessionStore(new MemoryStorage())
    const rec = v2Record()
    store.save(rec)

    const loaded = store.load(GW, DAEMON)
    expect(loaded).not.toBeNull()
    expect(loaded?.v).toBe(2)
    expect(loaded?.rootKeys).toBeDefined()
    expect(fromBase64Url(loaded?.rootKeys.d2p ?? '')).toEqual(rootD2p)
    expect(fromBase64Url(loaded?.rootKeys.p2d ?? '')).toEqual(rootP2d)
  })

  // S2 — CENTERPIECE: the rehydrated root DRIVES deriveConnectionKeys. A connKey derived from the
  // loaded root + a salt pair must byte-equal one derived from the original live root + the SAME salts.
  // This is the reload consumer: the whole reason the phone persists the root.
  test('the rehydrated root reproduces the same connKey as the live root', () => {
    const store = createDeviceSessionStore(new MemoryStorage())
    store.save(v2Record())
    const loaded = store.load(GW, DAEMON)
    if (!loaded) throw new Error('record did not load')

    const ids: HandshakeIds = {
      daemonId: DAEMON,
      deviceId: DEVICE,
      protocolVersion: REMOTE_CRYPTO_VERSION,
    }
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()

    const fromLive = deriveConnectionKeys({ rootD2p, rootP2d, phoneConnSalt, daemonConnSalt, ids })
    const fromStored = deriveConnectionKeys({
      rootD2p: fromBase64Url(loaded.rootKeys.d2p),
      rootP2d: fromBase64Url(loaded.rootKeys.p2d),
      phoneConnSalt,
      daemonConnSalt,
      ids,
    })

    expect(fromStored.d2p).toEqual(fromLive.d2p)
    expect(fromStored.p2d).toEqual(fromLive.p2d)
    // sanity: the connKey is NOT the root (rekey actually happened — guards against a future no-op derive).
    expect(fromStored.p2d).not.toEqual(rootP2d)
  })

  // S3 — a stale v:1 record under the OLD prefix is treated as absent. The phone re-pairs.
  test('a legacy v1 record is treated as null (forces re-pair)', () => {
    const backing = new MemoryStorage()
    const store = createDeviceSessionStore(backing)
    // simulate a pre-M6.1 record written under the v1 namespace
    backing.setItem(
      `hive.device-session.v1:${GW}:${DAEMON}`,
      JSON.stringify({
        v: 1,
        gatewayUrl: GW,
        daemonId: DAEMON,
        deviceId: DEVICE,
        deviceKeyPair: {
          secretKey: toBase64Url(new Uint8Array(32).fill(1)),
          publicKey: toBase64Url(new Uint8Array(32).fill(2)),
        },
        daemonPublicKey: toBase64Url(new Uint8Array(32).fill(3)),
        protocolVersion: 1,
        pairedAt: 1,
      })
    )

    expect(store.load(GW, DAEMON)).toBeNull()
  })

  // S3b — HARDEN minor: loading also WIPES the stale v1 record so the dead, identity-bearing keypair
  // doesn't linger at rest in localStorage.
  test('loading wipes a stale v1 record from localStorage', () => {
    const backing = new MemoryStorage()
    const legacyKey = `hive.device-session.v1:${GW}:${DAEMON}`
    backing.setItem(
      legacyKey,
      JSON.stringify({
        v: 1,
        gatewayUrl: GW,
        daemonId: DAEMON,
        deviceId: DEVICE,
        deviceKeyPair: { secretKey: 'aaaa', publicKey: 'bbbb' },
        daemonPublicKey: 'cccc',
        protocolVersion: 1,
        pairedAt: 1,
      })
    )
    const store = createDeviceSessionStore(backing)

    expect(store.load(GW, DAEMON)).toBeNull()
    expect(backing.getItem(legacyKey)).toBeNull() // wiped
  })

  // S4 — a v2 record missing rootKeys (or with a malformed rootKeys shape) is rejected as not-stored.
  test('a v2 record without a well-formed rootKeys is treated as null', () => {
    const backing = new MemoryStorage()
    const store = createDeviceSessionStore(backing)
    const { rootKeys: _omit, ...withoutRoots } = v2Record()
    backing.setItem(`hive.device-session.v2:${GW}:${DAEMON}`, JSON.stringify(withoutRoots))
    expect(store.load(GW, DAEMON)).toBeNull()

    backing.setItem(
      `hive.device-session.v2:${GW}:${DAEMON}`,
      JSON.stringify({ ...v2Record(), rootKeys: { d2p: 123, p2d: 456 } })
    )
    expect(store.load(GW, DAEMON)).toBeNull()
  })

  // S5 — round trips under the v2 prefix; clear removes it.
  test('save/load/clear operate under the v2 namespace', () => {
    const backing = new MemoryStorage()
    const store = createDeviceSessionStore(backing)
    store.save(v2Record())
    expect(backing.getItem(`hive.device-session.v2:${GW}:${DAEMON}`)).not.toBeNull()
    store.clear(GW, DAEMON)
    expect(store.load(GW, DAEMON)).toBeNull()
  })
})
