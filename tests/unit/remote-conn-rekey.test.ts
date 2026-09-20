import { randomBytes } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, test } from 'vitest'
import {
  buildNonce,
  CONN_SALT_LEN,
  type ConnectionKeys,
  createSealer,
  deriveConnectionKeys,
  generateConnSalt,
  type HandshakeIds,
  openFrame,
  REMOTE_CRYPTO_VERSION,
  SESSION_KEY_LEN,
  sealFrame,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import { encodeHeader, FrameKind } from '../../src/shared/remote-protocol.js'
import { createSealRecorder } from '../helpers/seal-recorder.js'

// M6.1 — per-connection rekey. Pure crypto: no jsdom, no I/O, no mocking. Drives the real
// deriveConnectionKeys + the real seal path over real random roots/salts, and proves the
// no-(key,nonce)-reuse invariant that closes the page-reload nonce-reuse hole.

const IDS: HandshakeIds = {
  daemonId: 'daemon-A',
  deviceId: 'device-1',
  protocolVersion: REMOTE_CRYPTO_VERSION,
}

function root(): { rootD2p: Uint8Array; rootP2d: Uint8Array } {
  return { rootD2p: randomBytes(SESSION_KEY_LEN), rootP2d: randomBytes(SESSION_KEY_LEN) }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Copy `bytes` with the bit at index `i` flipped — mutate real input without an unchecked index. */
function withFlippedByte(bytes: Uint8Array, i: number): Uint8Array {
  const out = Uint8Array.from(bytes)
  out.set([(out[i] ?? 0) ^ 0x01], i)
  return out
}

function fixedHeader(streamId: number, seq: number): Uint8Array {
  return encodeHeader({
    version: REMOTE_CRYPTO_VERSION,
    kind: FrameKind.Data,
    flags: 0,
    streamId,
    seq,
  })
}

/** Seal one frame under a connKey direction, recording the (key, nonce) into the shared recorder. */
function sealRecorded(
  rec: ReturnType<typeof createSealRecorder>,
  key: Uint8Array,
  direction: 'd2p' | 'p2d',
  sealer: ReturnType<typeof createSealer>,
  streamId: number,
  payload: Uint8Array
): void {
  const headerBytes = fixedHeader(streamId, sealer.nextSeq)
  rec.record({ key, direction, headerBytes })
  sealNext(sealer, { key, streamId, headerBytes, payload })
}

// ── A1 — connKey agreement (both sides derive byte-identical keys) ───────────────
describe('A1 connKey agreement', () => {
  test('matched roots + salts + ids ⇒ daemon and device derive identical d2p/p2d', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()
    // Both sides call the SAME function with the SAME inputs — that is the wire agreement.
    const device = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    const daemon = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    expect(bytesEqual(device.d2p, daemon.d2p)).toBe(true)
    expect(bytesEqual(device.p2d, daemon.p2d)).toBe(true)
    expect(device.d2p.length).toBe(32)
    expect(device.p2d.length).toBe(32)
    // distinct directions: a missing per-direction info label would make d2p == p2d.
    expect(bytesEqual(device.d2p, device.p2d)).toBe(false)
  })
})

// ── A2 — connKey ≠ root (the rekey is not bypassed) ──────────────────────────────
describe('A2 connKey != root', () => {
  test('derived keys never equal the root they came from (the cheapest tripwire)', () => {
    for (let i = 0; i < 8; i++) {
      const r = root()
      const k = deriveConnectionKeys({
        ...r,
        phoneConnSalt: generateConnSalt(),
        daemonConnSalt: generateConnSalt(),
        ids: IDS,
      })
      expect(bytesEqual(k.d2p, r.rootD2p)).toBe(false)
      expect(bytesEqual(k.p2d, r.rootP2d)).toBe(false)
      // also never crossed
      expect(bytesEqual(k.d2p, r.rootP2d)).toBe(false)
      expect(bytesEqual(k.p2d, r.rootD2p)).toBe(false)
    }
  })
})

// ── A3 — salt is load-bearing (each salt changes the key) ────────────────────────
describe('A3 salt load-bearing', () => {
  test('varying phoneSalt (root + daemonSalt fixed) ⇒ different connKey', () => {
    const r = root()
    const daemonConnSalt = generateConnSalt()
    const a = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt,
      ids: IDS,
    })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt,
      ids: IDS,
    })
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
  })

  test('varying daemonSalt (root + phoneSalt fixed) ⇒ different connKey', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const a = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
  })

  test('flipping one byte of either salt changes the key (no constant salt/info)', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()
    const base = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })

    const flippedPhone = deriveConnectionKeys({
      ...r,
      phoneConnSalt: withFlippedByte(phoneConnSalt, 0),
      daemonConnSalt,
      ids: IDS,
    })
    expect(bytesEqual(base.d2p, flippedPhone.d2p)).toBe(false)

    const flippedDaemon = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt: withFlippedByte(daemonConnSalt, 31),
      ids: IDS,
    })
    expect(bytesEqual(base.p2d, flippedDaemon.p2d)).toBe(false)
  })
})

// ── A4 — bilateral freshness (neither side alone can force a repeat) ─────────────
describe('A4 bilateral freshness', () => {
  test('replayed phoneSalt + fresh daemonSalt ⇒ fresh key (phone replay cannot force reuse)', () => {
    const r = root()
    const replayedPhone = generateConnSalt() // attacker pins the phone contribution
    const a = deriveConnectionKeys({
      ...r,
      phoneConnSalt: replayedPhone,
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt: replayedPhone,
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
  })

  test('replayed daemonSalt + fresh phoneSalt ⇒ fresh key (daemon replay cannot force reuse)', () => {
    const r = root()
    const replayedDaemon = generateConnSalt()
    const a = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt: replayedDaemon,
      ids: IDS,
    })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt: replayedDaemon,
      ids: IDS,
    })
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
  })
})

// ── A5 — CENTERPIECE: no (key, nonce) reuse across two connections from one root ──
describe('A5 no nonce reuse across a reload', () => {
  // Two connections from the SAME persisted root (the page-reload scenario): each draws a fresh
  // bilateral salt and a fresh sealer at seq 0. Record every (connKey, nonce) used to seal, both
  // directions, and assert zero dupes.
  function runConnection(
    rec: ReturnType<typeof createSealRecorder>,
    r: { rootD2p: Uint8Array; rootP2d: Uint8Array },
    phoneConnSalt: Uint8Array,
    daemonConnSalt: Uint8Array,
    deriveKeys: (args: {
      rootD2p: Uint8Array
      rootP2d: Uint8Array
      phoneConnSalt: Uint8Array
      daemonConnSalt: Uint8Array
      ids: HandshakeIds
    }) => ConnectionKeys
  ): void {
    const keys = deriveKeys({
      rootD2p: r.rootD2p,
      rootP2d: r.rootP2d,
      phoneConnSalt,
      daemonConnSalt,
      ids: IDS,
    })
    // fresh sealers at seq 0 — exactly what a reload (fresh mux) / reconnect (fresh bridge) does.
    const deviceSealer = createSealer('p2d')
    const daemonSealer = createSealer('d2p')
    // device seals the binding Hello on the channel stream (0, 0), then data on odd streams.
    sealRecorded(rec, keys.p2d, 'p2d', deviceSealer, 0, new Uint8Array([0x02]))
    sealRecorded(rec, keys.p2d, 'p2d', deviceSealer, 1, new Uint8Array([1]))
    sealRecorded(rec, keys.p2d, 'p2d', deviceSealer, 3, new Uint8Array([2]))
    // daemon seals replies on the channel stream + even streams.
    sealRecorded(rec, keys.d2p, 'd2p', daemonSealer, 0, new Uint8Array([0x02]))
    sealRecorded(rec, keys.d2p, 'd2p', daemonSealer, 2, new Uint8Array([3]))
    sealRecorded(rec, keys.d2p, 'd2p', daemonSealer, 4, new Uint8Array([4]))
  }

  test('two connections from one root ⇒ zero (key,nonce) dupes', () => {
    const rec = createSealRecorder()
    const r = root()
    runConnection(rec, r, generateConnSalt(), generateConnSalt(), deriveConnectionKeys)
    runConnection(rec, r, generateConnSalt(), generateConnSalt(), deriveConnectionKeys)
    expect(rec.count()).toBe(12) // sanity: the recorder actually observed seals
    expect(rec.dupes()).toBe(0)
  })

  test('BITE: sealing under the raw root (rekey bypassed) DOES reuse a nonce', () => {
    // Simulate the pre-fix behavior: deriveConnectionKeys replaced by "return the root unchanged".
    const noRekey = (args: { rootD2p: Uint8Array; rootP2d: Uint8Array }): ConnectionKeys => ({
      d2p: args.rootD2p,
      p2d: args.rootP2d,
    })
    const rec = createSealRecorder()
    const r = root()
    runConnection(rec, r, generateConnSalt(), generateConnSalt(), noRekey as never)
    runConnection(rec, r, generateConnSalt(), generateConnSalt(), noRekey as never)
    // The two Hellos collide on (rootP2d, nonce(p2d, 0, 0)); both data streams collide too.
    expect(rec.dupes()).toBeGreaterThan(0)
  })
})

// ── A6 — within one connection, connKey + monotonic seq stays unique ─────────────
describe('A6 in-connection uniqueness', () => {
  test('seq 0..N on one stream + seq 0 across distinct streams ⇒ all tuples distinct', () => {
    const rec = createSealRecorder()
    const r = root()
    const keys = deriveConnectionKeys({
      rootD2p: r.rootD2p,
      rootP2d: r.rootP2d,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    const sealer = createSealer('p2d')
    for (let seq = 0; seq < 16; seq++) {
      sealRecorded(rec, keys.p2d, 'p2d', sealer, 1, new Uint8Array([seq]))
    }
    // distinct streams at seq 0 fold streamId into the nonce — still unique.
    for (const sid of [3, 5, 7]) {
      const h = fixedHeader(sid, 0)
      rec.record({ key: keys.p2d, direction: 'p2d', headerBytes: h })
    }
    expect(rec.dupes()).toBe(0)
  })
})

// ── A7 — connection-context binding (ids fold into info) ─────────────────────────
describe('A7 connection-context binding', () => {
  test('different deviceId ⇒ different connKey (same roots + salts)', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()
    const a = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt,
      ids: { ...IDS, deviceId: 'device-2' },
    })
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
  })

  test('different protocolVersion ⇒ different connKey', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()
    const a = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt,
      ids: { ...IDS, protocolVersion: 99 },
    })
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false)
  })

  test('different daemonId ⇒ different connKey (info must match across the wire)', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonConnSalt = generateConnSalt()
    const a = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt,
      ids: { ...IDS, daemonId: 'daemon-B' },
    })
    expect(bytesEqual(a.d2p, b.d2p)).toBe(false)
  })
})

// ── A8 (HARDEN major a) — a swapped salt makes the sealed Hello fail to open ─────
describe('A8 salt swap breaks the sealed Hello (the binding the spec sells)', () => {
  // The salt feeds HKDF, so a MITM that swaps either party's salt yields a connKey the other side
  // cannot reproduce. A frame sealed under connKey(saltsA) must fail to open under connKey(saltsB).
  test('seal under conn-A key, open under conn-B key (swapped daemonSalt) ⇒ invalid tag', () => {
    const r = root()
    const phoneConnSalt = generateConnSalt()
    const daemonSaltA = generateConnSalt()
    const daemonSaltB = generateConnSalt() // attacker swaps the daemon's contribution
    const keysA = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt: daemonSaltA,
      ids: IDS,
    })
    const keysB = deriveConnectionKeys({
      ...r,
      phoneConnSalt,
      daemonConnSalt: daemonSaltB,
      ids: IDS,
    })
    const header = fixedHeader(0, 0)
    const ct = sealFrame({
      key: keysA.p2d,
      direction: 'p2d',
      headerBytes: header,
      payload: new Uint8Array([0x02, 1, 2, 3]),
    })
    expect(() =>
      openFrame({ key: keysB.p2d, direction: 'p2d', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })

  test('a swapped phoneSalt likewise breaks the open', () => {
    const r = root()
    const daemonConnSalt = generateConnSalt()
    const phoneSaltA = generateConnSalt()
    const phoneSaltB = generateConnSalt()
    const keysA = deriveConnectionKeys({
      ...r,
      phoneConnSalt: phoneSaltA,
      daemonConnSalt,
      ids: IDS,
    })
    const keysB = deriveConnectionKeys({
      ...r,
      phoneConnSalt: phoneSaltB,
      daemonConnSalt,
      ids: IDS,
    })
    const header = fixedHeader(0, 0)
    const ct = sealFrame({
      key: keysA.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([0x02, 9]),
    })
    expect(() =>
      openFrame({ key: keysB.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── A9 (HARDEN minor) — conn label namespace never collides with pairing labels ──
describe('A9 label namespace guard', () => {
  // A future maintainer who reused a v1 pairing label for a conn key would silently weaken the
  // schedule. Pin that deriveConnectionKeys does NOT equal an HKDF under a v1-pair-flavored label.
  test('connKey.d2p != hkdf(root, <v1-pair salt>, <v1 key label>, 32)', () => {
    const r = root()
    const phoneConnSalt = new Uint8Array(CONN_SALT_LEN).fill(0xaa)
    const daemonConnSalt = new Uint8Array(CONN_SALT_LEN).fill(0xbb)
    const k = deriveConnectionKeys({ ...r, phoneConnSalt, daemonConnSalt, ids: IDS })
    const te = new TextEncoder()
    const v1Like = hkdf(
      sha256,
      r.rootD2p,
      te.encode('hive/remote/v1/pair'),
      te.encode('hive/remote/v1/key/daemon->device'),
      32
    )
    expect(bytesEqual(k.d2p, v1Like)).toBe(false)
  })
})

// ── A10 — the nonce a connKey uses at (0,0) is not magically unique by itself ─────
describe('A10 freshness comes from the key, not the nonce', () => {
  // Two connections both seal the Hello at the SAME nonce (p2d, 0, 0). Safety comes ONLY from the
  // connKey differing. Prove the nonces collide but the (key, nonce) tuples don't.
  test('same nonce(p2d,0,0) across connections, different connKey ⇒ tuple still unique', () => {
    const r = root()
    const n1 = buildNonce('p2d', 0, 0)
    const n2 = buildNonce('p2d', 0, 0)
    expect(bytesEqual(n1, n2)).toBe(true) // the nonce repeats — by design (seq reset to 0)

    const a = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    const b = deriveConnectionKeys({
      ...r,
      phoneConnSalt: generateConnSalt(),
      daemonConnSalt: generateConnSalt(),
      ids: IDS,
    })
    expect(bytesEqual(a.p2d, b.p2d)).toBe(false) // …but the key does not, so the tuple is unique
  })
})
