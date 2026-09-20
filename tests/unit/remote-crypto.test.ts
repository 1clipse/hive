import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'
import {
  AEAD_TAG_LEN,
  buildNonce,
  createOpener,
  createSealer,
  decodePairingPayload,
  deriveDaemonSession,
  deriveDeviceSession,
  deriveSas,
  deserializeDeviceKeyPair,
  encodePairingPayload,
  fromBase64Url,
  generateDeviceKeyPair,
  type HandshakeIds,
  NONCE_LEN,
  openFrame,
  openNext,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  sealFrame,
  sealNext,
  serializeDeviceKeyPair,
  toBase64Url,
  X25519_KEY_LEN,
} from '../../src/shared/remote-crypto.js'

// ── Test helpers ──────────────────────────────────────────────────────────

const IDS: HandshakeIds = {
  daemonId: 'daemon-A',
  deviceId: 'device-1',
  protocolVersion: REMOTE_CRYPTO_VERSION,
}

function fixedHeader(streamId: number, seq: number, kind = 0x02): Uint8Array {
  // Mirror the protocol 12-byte header layout: streamId@4 (u32be), seq@8 (u32be).
  // Crypto reads streamId/seq out of THESE bytes — they are the single source of truth.
  const h = new Uint8Array(12)
  const dv = new DataView(h.buffer)
  dv.setUint8(0, REMOTE_CRYPTO_VERSION)
  dv.setUint8(1, kind)
  dv.setUint16(2, 0)
  dv.setUint32(4, streamId)
  dv.setUint32(8, seq)
  return h
}

/** A full daemon+device handshake over matched ECDH inputs, returning both sides' keys. */
function handshake(opts?: {
  ids?: HandshakeIds
  pairingSecret?: Uint8Array
  sessionSalt?: Uint8Array
  daemonSk?: Uint8Array
  deviceSk?: Uint8Array
}) {
  const ids = opts?.ids ?? IDS
  const pairingSecret = opts?.pairingSecret ?? randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = opts?.sessionSalt ?? randomBytes(32)
  const daemonSk = opts?.daemonSk ?? x25519.utils.randomSecretKey()
  const deviceSk = opts?.deviceSk ?? x25519.utils.randomSecretKey()
  const daemonPk = x25519.getPublicKey(daemonSk)
  const devicePk = x25519.getPublicKey(deviceSk)

  const daemon = deriveDaemonSession({
    daemonSecretKey: daemonSk,
    devicePublicKey: devicePk,
    daemonPublicKey: daemonPk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  const device = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  return { daemon, device, pairingSecret, sessionSalt, daemonPk, devicePk, daemonSk, deviceSk, ids }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Return a copy of `bytes` with one bit flipped at `i` — used to mutate real product output. */
function withFlippedByte(bytes: Uint8Array, i: number): Uint8Array {
  const out = Uint8Array.from(bytes)
  out[i] = (out[i] ?? 0) ^ 0x01
  return out
}

// ── 1. Handshake agreement ──────────────────────────────────────────────────
// Invariant 2 (directional keys), invariant 4 (transcript binding) positive case.
describe('handshake agreement', () => {
  test('daemon and device derive identical d2p/p2d/sas/transcriptHash', () => {
    const { daemon, device } = handshake()
    expect(bytesEqual(daemon.d2p, device.d2p)).toBe(true)
    expect(bytesEqual(daemon.p2d, device.p2d)).toBe(true)
    expect(daemon.sas).toBe(device.sas)
    expect(bytesEqual(daemon.transcriptHash, device.transcriptHash)).toBe(true)
    expect(daemon.d2p.length).toBe(32)
    expect(daemon.p2d.length).toBe(32)
  })
})

// ── 2. SAS agreement + shape ──────────────────────────────────────────────────
describe('SAS', () => {
  test('both sides agree and SAS is 6 digits', () => {
    const { daemon, device } = handshake()
    expect(daemon.sas).toBe(device.sas)
    expect(daemon.sas).toMatch(/^\d{6}$/)
  })

  // ── 3. SAS transcript-sensitive ─────────────────────────────────────────────
  test('flipping one bit of the transcript hash changes the SAS (not constant/decorative)', () => {
    const { daemon, ids } = handshake()
    const tampered = withFlippedByte(daemon.transcriptHash, 0)
    const sasA = daemon.sas
    const sasB = deriveSas(tampered, ids)
    // A decorative SAS that ignores the transcript would produce the same code.
    expect(sasB).not.toBe(sasA)
  })

  test('SAS keeps leading zeros (always 6 chars)', () => {
    // Search for a transcript hash that maps to a low code to prove padding.
    let found = false
    for (let i = 0; i < 4000 && !found; i++) {
      const th = randomBytes(32)
      const sas = deriveSas(th, IDS)
      expect(sas).toHaveLength(6)
      if (sas.startsWith('0')) found = true
    }
    expect(found).toBe(true)
  })
})

// ── 4. Third party cannot derive ──────────────────────────────────────────────
describe('pairing secret is load-bearing', () => {
  test('wrong pairingSecret yields different keys; real frame fails to open', () => {
    const a = handshake()
    // Attacker knows both pubkeys, ids, session salt — but NOT the pairing secret.
    const attacker = deriveDeviceSession({
      deviceSecretKey: a.deviceSk,
      daemonPublicKey: a.daemonPk,
      devicePublicKey: a.devicePk,
      pairingSecret: randomBytes(PAIRING_SECRET_LEN), // wrong secret
      sessionSalt: a.sessionSalt,
      ids: a.ids,
    })
    expect(bytesEqual(attacker.d2p, a.daemon.d2p)).toBe(false)
    expect(bytesEqual(attacker.p2d, a.daemon.p2d)).toBe(false)

    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: a.daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    // The ONLY acceptable failure is the AEAD tag rejection. A bare .toThrow() would also be
    // satisfied by a spurious runner error or by the frame opening into garbage that some later
    // assert trips on — neither of which proves the wrong key was rejected. Pin the reason.
    expect(() =>
      openFrame({ key: attacker.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── 5. Seal/open round-trip baseline ──────────────────────────────────────────
describe('seal/open round-trip', () => {
  test('non-empty payload round-trips and ct is payload+16', () => {
    const { daemon, device } = handshake()
    const header = fixedHeader(3, 0)
    const payload = new Uint8Array([9, 8, 7, 6, 5])
    const ct = sealFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: header, payload })
    expect(ct.length).toBe(payload.length + AEAD_TAG_LEN)
    const pt = openFrame({ key: device.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    expect(bytesEqual(pt, payload)).toBe(true)
  })

  test('empty payload yields ct of length 16', () => {
    const { daemon, device } = handshake()
    const header = fixedHeader(3, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array(0),
    })
    expect(ct.length).toBe(AEAD_TAG_LEN)
    const pt = openFrame({ key: device.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    expect(pt.length).toBe(0)
  })
})

// ── 6. Header-as-AAD tamper (invariant 1) ─────────────────────────────────────
describe('header is authenticated as AAD (invariant 1)', () => {
  test('flipping a header byte (kind) makes openFrame throw', () => {
    const { daemon } = handshake()
    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    // flip kind — a field the nonce does NOT read, so this only fails via AAD authentication.
    // Match the AEAD reject reason: if the product drops AAD, decrypt SUCCEEDS (no throw) and this
    // fails; if it throws for any other reason the regex also fails. The bare .toThrow() was the
    // gate's flake surface — it could pass on a non-crypto exception and mask a real AAD regression.
    const tampered = withFlippedByte(header, 1)
    expect(() =>
      openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: tampered, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })

  test('flipping flags byte makes openFrame throw (AAD only, not nonce)', () => {
    const { daemon } = handshake()
    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    const tampered = withFlippedByte(header, 2)
    expect(() =>
      openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: tampered, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── 7. Ciphertext tamper ──────────────────────────────────────────────────────
describe('ciphertext tamper', () => {
  test('flipping one ciphertext byte makes openFrame throw', () => {
    const { daemon } = handshake()
    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    const tampered = withFlippedByte(ct, 0)
    expect(() =>
      openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: header, ciphertext: tampered })
    ).toThrow(/invalid tag/)
  })
})

// ── 8. Header/payload binding ─────────────────────────────────────────────────
describe('header/payload binding', () => {
  test('ciphertext from frame A presented with frame B header throws', () => {
    const { daemon } = handshake()
    const headerA = fixedHeader(1, 0)
    const headerB = fixedHeader(1, 1) // same stream, different seq
    const ctA = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: headerA,
      payload: new Uint8Array([1, 2, 3]),
    })
    expect(() =>
      openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: headerB, ciphertext: ctA })
    ).toThrow(/invalid tag/)
  })
})

// ── 9. Directional keys distinct (invariant 2) ────────────────────────────────
describe('directional keys (invariant 2)', () => {
  test('d2p and p2d differ byte-wise', () => {
    const { daemon } = handshake()
    expect(bytesEqual(daemon.d2p, daemon.p2d)).toBe(false)
  })

  // ── 10. Wrong-direction key fails open ──────────────────────────────────────
  test('seal with d2p, open with p2d throws', () => {
    const { daemon } = handshake()
    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    // Wrong key AND wrong direction tag in nonce — must fail closed with the AEAD reject.
    expect(() =>
      openFrame({ key: daemon.p2d, direction: 'p2d', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── 11. Replay rejected (invariant 3 sequencing) ──────────────────────────────
describe('replay / reorder guard (invariant 3)', () => {
  test('replaying an already-accepted seq throws', () => {
    const { daemon, device } = handshake()
    const sealer = createSealer('d2p')
    const opener = createOpener('d2p')
    const frames: { headerBytes: Uint8Array; seq: number; ciphertext: Uint8Array }[] = []
    for (let i = 0; i < 3; i++) {
      const header = fixedHeader(1, i)
      const r = sealNext(sealer, {
        key: daemon.d2p,
        streamId: 1,
        headerBytes: header,
        payload: new Uint8Array([i]),
      })
      frames.push({ headerBytes: header, seq: r.seq, ciphertext: r.ciphertext })
    }
    // accept 0,1,2
    for (const f of frames) {
      openNext(opener, {
        key: device.d2p,
        streamId: 1,
        headerBytes: f.headerBytes,
        ciphertext: f.ciphertext,
        seq: f.seq,
      })
    }
    // replay seq 1
    const replay = frames[1]
    if (!replay) throw new Error('expected three sealed frames')
    expect(() =>
      openNext(opener, {
        key: device.d2p,
        streamId: 1,
        headerBytes: replay.headerBytes,
        ciphertext: replay.ciphertext,
        seq: replay.seq,
      })
    ).toThrow(/out-of-order or replayed/)
  })

  // ── 12. Reorder / gap rejected ──────────────────────────────────────────────
  test('a gap (seq 0 then seq 2) throws — snapshot-not-delta means no gap tolerance', () => {
    const { daemon, device } = handshake()
    const sealer = createSealer('d2p')
    const opener = createOpener('d2p')
    const h0 = fixedHeader(1, 0)
    const f0 = sealNext(sealer, {
      key: daemon.d2p,
      streamId: 1,
      headerBytes: h0,
      payload: new Uint8Array([0]),
    })
    // burn seq 1 on the sealer so the next is seq 2
    sealNext(sealer, {
      key: daemon.d2p,
      streamId: 1,
      headerBytes: fixedHeader(1, 1),
      payload: new Uint8Array([1]),
    })
    const h2 = fixedHeader(1, 2)
    const f2 = sealNext(sealer, {
      key: daemon.d2p,
      streamId: 1,
      headerBytes: h2,
      payload: new Uint8Array([2]),
    })
    openNext(opener, {
      key: device.d2p,
      streamId: 1,
      headerBytes: h0,
      ciphertext: f0.ciphertext,
      seq: f0.seq,
    })
    expect(() =>
      openNext(opener, {
        key: device.d2p,
        streamId: 1,
        headerBytes: h2,
        ciphertext: f2.ciphertext,
        seq: f2.seq,
      })
    ).toThrow(/out-of-order or replayed/)
  })
})

// ── 13. Nonce bound to streamId (invariant 3 cross-stream) ─────────────────────
describe('nonce binding (invariant 3)', () => {
  test('same seq on different streams yields different nonces', () => {
    const n1 = buildNonce('d2p', 1, 7)
    const n2 = buildNonce('d2p', 2, 7)
    expect(n1.length).toBe(NONCE_LEN)
    expect(bytesEqual(n1, n2)).toBe(false)
  })

  test('buildNonce is injective over a (dir,streamId,seq) grid', () => {
    const seen = new Set<string>()
    for (const dir of ['d2p', 'p2d'] as const) {
      for (let s = 0; s < 5; s++) {
        for (let q = 0; q < 5; q++) {
          const n = buildNonce(dir, s, q)
          const key = Array.from(n).join(',')
          expect(seen.has(key)).toBe(false)
          seen.add(key)
        }
      }
    }
  })

  // ── 15. Within-stream nonce never repeats ───────────────────────────────────
  test('nonces for seq 0..N on one stream are all unique', () => {
    const seen = new Set<string>()
    for (let q = 0; q < 64; q++) {
      const n = buildNonce('d2p', 1, q)
      const key = Array.from(n).join(',')
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

// ── 14. Cross-stream nonce reuse fails closed ─────────────────────────────────
describe('cross-stream nonce reuse fails closed (invariant 3)', () => {
  test('seal (stream=1,seq=7), open presenting (stream=2,seq=7) throws', () => {
    const { daemon } = handshake()
    const headerStream1 = fixedHeader(1, 7)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: headerStream1,
      payload: new Uint8Array([1, 2, 3]),
    })
    // Present a header that claims stream 2 — crypto reads streamId from header,
    // so the nonce changes AND the AAD changes. Either way: throw.
    const headerStream2 = fixedHeader(2, 7)
    expect(() =>
      openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: headerStream2, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── 16. Version downgrade — transcript (invariant 4) ──────────────────────────
describe('transcript binding (invariant 4)', () => {
  test('mismatched protocolVersion → divergent keys/sas → frame does not open', () => {
    const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
    const sessionSalt = randomBytes(32)
    const daemonSk = x25519.utils.randomSecretKey()
    const deviceSk = x25519.utils.randomSecretKey()
    const daemonPk = x25519.getPublicKey(daemonSk)
    const devicePk = x25519.getPublicKey(deviceSk)

    const daemon = deriveDaemonSession({
      daemonSecretKey: daemonSk,
      devicePublicKey: devicePk,
      daemonPublicKey: daemonPk,
      pairingSecret,
      sessionSalt,
      ids: { daemonId: 'd', deviceId: 'p', protocolVersion: 2 }, // downgraded/forged
    })
    const device = deriveDeviceSession({
      deviceSecretKey: deviceSk,
      daemonPublicKey: daemonPk,
      devicePublicKey: devicePk,
      pairingSecret,
      sessionSalt,
      ids: { daemonId: 'd', deviceId: 'p', protocolVersion: 1 },
    })
    expect(bytesEqual(daemon.transcriptHash, device.transcriptHash)).toBe(false)
    expect(bytesEqual(daemon.d2p, device.d2p)).toBe(false)
    expect(daemon.sas).not.toBe(device.sas)

    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1]),
    })
    // Divergent transcript → divergent d2p → the AEAD tag must reject. Pin the reason so a
    // downgrade that somehow yielded a coincidentally-openable frame can't slip through silently.
    expect(() =>
      openFrame({ key: device.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })
})

// ── 17. Version downgrade — at scan ───────────────────────────────────────────
describe('pairing payload version check', () => {
  test('decodePairingPayload with v:0 throws RangeError', () => {
    const good = {
      v: REMOTE_CRYPTO_VERSION,
      gatewayUrl: 'wss://gw.example',
      daemonId: 'd',
      pairingSecret: toBase64Url(randomBytes(PAIRING_SECRET_LEN)),
    }
    const bad = JSON.stringify({ ...good, v: 0 })
    expect(() => decodePairingPayload(bad)).toThrow(RangeError)
  })

  test('round-trips a valid payload', () => {
    const p = {
      v: REMOTE_CRYPTO_VERSION,
      gatewayUrl: 'wss://gw.example',
      daemonId: 'daemon-A',
      pairingSecret: toBase64Url(randomBytes(PAIRING_SECRET_LEN)),
    }
    const decoded = decodePairingPayload(encodePairingPayload(p))
    expect(decoded).toEqual(p)
  })

  test('rejects a pairingSecret that is not 32 bytes', () => {
    const bad = JSON.stringify({
      v: REMOTE_CRYPTO_VERSION,
      gatewayUrl: 'wss://gw.example',
      daemonId: 'd',
      pairingSecret: toBase64Url(randomBytes(16)),
    })
    expect(() => decodePairingPayload(bad)).toThrow(RangeError)
  })
})

// ── 18. Misbind daemonId (invariant 4) ────────────────────────────────────────
describe('id misbinding (invariant 4)', () => {
  test('daemonId mismatch → divergent keys/sas', () => {
    const shared = {
      pairingSecret: randomBytes(PAIRING_SECRET_LEN),
      sessionSalt: randomBytes(32),
      daemonSk: x25519.utils.randomSecretKey(),
      deviceSk: x25519.utils.randomSecretKey(),
    }
    const daemonPk = x25519.getPublicKey(shared.daemonSk)
    const devicePk = x25519.getPublicKey(shared.deviceSk)
    const daemon = deriveDaemonSession({
      daemonSecretKey: shared.daemonSk,
      devicePublicKey: devicePk,
      daemonPublicKey: daemonPk,
      pairingSecret: shared.pairingSecret,
      sessionSalt: shared.sessionSalt,
      ids: { daemonId: 'A', deviceId: 'p', protocolVersion: 1 },
    })
    const device = deriveDeviceSession({
      deviceSecretKey: shared.deviceSk,
      daemonPublicKey: daemonPk,
      devicePublicKey: devicePk,
      pairingSecret: shared.pairingSecret,
      sessionSalt: shared.sessionSalt,
      ids: { daemonId: 'B', deviceId: 'p', protocolVersion: 1 },
    })
    expect(bytesEqual(daemon.d2p, device.d2p)).toBe(false)
    expect(daemon.sas).not.toBe(device.sas)
  })

  // ── 19. Misbind deviceId ────────────────────────────────────────────────────
  test('deviceId mismatch → divergent keys/sas', () => {
    const shared = {
      pairingSecret: randomBytes(PAIRING_SECRET_LEN),
      sessionSalt: randomBytes(32),
      daemonSk: x25519.utils.randomSecretKey(),
      deviceSk: x25519.utils.randomSecretKey(),
    }
    const daemonPk = x25519.getPublicKey(shared.daemonSk)
    const devicePk = x25519.getPublicKey(shared.deviceSk)
    const daemon = deriveDaemonSession({
      daemonSecretKey: shared.daemonSk,
      devicePublicKey: devicePk,
      daemonPublicKey: daemonPk,
      pairingSecret: shared.pairingSecret,
      sessionSalt: shared.sessionSalt,
      ids: { daemonId: 'd', deviceId: 'X', protocolVersion: 1 },
    })
    const device = deriveDeviceSession({
      deviceSecretKey: shared.deviceSk,
      daemonPublicKey: daemonPk,
      devicePublicKey: devicePk,
      pairingSecret: shared.pairingSecret,
      sessionSalt: shared.sessionSalt,
      ids: { daemonId: 'd', deviceId: 'Y', protocolVersion: 1 },
    })
    expect(bytesEqual(daemon.d2p, device.d2p)).toBe(false)
    expect(daemon.sas).not.toBe(device.sas)
  })
})

// ── 20. Canonical transcript (length-prefix) ──────────────────────────────────
describe('canonical transcript', () => {
  test('(daemonId=ab,deviceId=c) vs (daemonId=a,deviceId=bc) yield different transcriptHash', () => {
    const shared = {
      pairingSecret: randomBytes(PAIRING_SECRET_LEN),
      sessionSalt: randomBytes(32),
      daemonSk: x25519.utils.randomSecretKey(),
      deviceSk: x25519.utils.randomSecretKey(),
    }
    const daemonPk = x25519.getPublicKey(shared.daemonSk)
    const devicePk = x25519.getPublicKey(shared.deviceSk)
    const mk = (daemonId: string, deviceId: string) =>
      deriveDaemonSession({
        daemonSecretKey: shared.daemonSk,
        devicePublicKey: devicePk,
        daemonPublicKey: daemonPk,
        pairingSecret: shared.pairingSecret,
        sessionSalt: shared.sessionSalt,
        ids: { daemonId, deviceId, protocolVersion: 1 },
      })
    const a = mk('ab', 'c')
    const b = mk('a', 'bc')
    // Naive concat without length prefix would collide ('ab'+'c' === 'a'+'bc').
    expect(bytesEqual(a.transcriptHash, b.transcriptHash)).toBe(false)
  })
})

// ── 21. base64url roundtrip + rejection ───────────────────────────────────────
describe('base64url', () => {
  test('random arrays survive a roundtrip', () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = randomBytes(len)
      const round = fromBase64Url(toBase64Url(bytes))
      expect(bytesEqual(round, bytes)).toBe(true)
    }
  })

  test('out-of-alphabet char throws RangeError', () => {
    expect(() => fromBase64Url('!!')).toThrow(RangeError)
  })

  test('length % 4 === 1 throws RangeError', () => {
    expect(() => fromBase64Url('AAAAA')).toThrow(RangeError)
  })

  test('deserializeDeviceKeyPair with a 31-byte key throws RangeError', () => {
    const short = toBase64Url(randomBytes(31))
    expect(() =>
      deserializeDeviceKeyPair({ secretKey: short, publicKey: toBase64Url(randomBytes(32)) })
    ).toThrow(RangeError)
  })
})

// ── 22. Device keypair serialize roundtrip byte-exact ─────────────────────────
describe('device keypair serialization', () => {
  test('serialize/deserialize is byte-exact', () => {
    const kp = generateDeviceKeyPair()
    expect(kp.secretKey.length).toBe(X25519_KEY_LEN)
    expect(kp.publicKey.length).toBe(X25519_KEY_LEN)
    const round = deserializeDeviceKeyPair(serializeDeviceKeyPair(kp))
    expect(bytesEqual(round.secretKey, kp.secretKey)).toBe(true)
    expect(bytesEqual(round.publicKey, kp.publicKey)).toBe(true)
  })

  test('mutating one byte of the serialized secret changes the result', () => {
    const kp = generateDeviceKeyPair()
    const ser = serializeDeviceKeyPair(kp)
    const bytes = withFlippedByte(fromBase64Url(ser.secretKey), 0)
    const mutated = { secretKey: toBase64Url(bytes), publicKey: ser.publicKey }
    const round = deserializeDeviceKeyPair(mutated)
    expect(bytesEqual(round.secretKey, kp.secretKey)).toBe(false)
  })
})

// NOTE: the no-Buffer browser-safety guard lives in its own file
// (tests/unit/remote-crypto.no-buffer.test.ts). It mutates globalThis.Buffer, and
// vitest.config.ts runs files in a single non-parallel worker, so quarantining it into a
// separate module keeps that global mutation from leaking into the adversarial tests here.

// ── HARDEN: reconnect / session-freshness (blockers #1, #2; harden major §4) ───
describe('session freshness — nonce reuse across reconnects (harden blockers #1/#2)', () => {
  test('two independent handshakes produce distinct d2p and p2d byte-wise', () => {
    const a = handshake()
    const b = handshake()
    expect(bytesEqual(a.daemon.d2p, b.daemon.d2p)).toBe(false)
    expect(bytesEqual(a.daemon.p2d, b.daemon.p2d)).toBe(false)
  })

  test('a frame sealed in session A fails to open in session B', () => {
    const a = handshake()
    const b = handshake()
    const header = fixedHeader(1, 0)
    const ct = sealFrame({
      key: a.daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([1, 2, 3]),
    })
    expect(() =>
      openFrame({ key: b.daemon.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    ).toThrow(/invalid tag/)
  })

  test('regression: reusing ECDH + pairing secret across handshakes STILL yields distinct keys (per-session salt mandated)', () => {
    // Simulate a silent reconnect that reuses every cached input EXCEPT the fresh session salt.
    const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
    const daemonSk = x25519.utils.randomSecretKey()
    const deviceSk = x25519.utils.randomSecretKey()
    const a = handshake({ pairingSecret, daemonSk, deviceSk, sessionSalt: randomBytes(32) })
    const b = handshake({ pairingSecret, daemonSk, deviceSk, sessionSalt: randomBytes(32) })
    // ECDH ss and pairing IKM are identical between A and B; only the salt differs.
    // If salt freshness were removed, these would collide → seq=0 reset = nonce reuse.
    expect(bytesEqual(a.daemon.d2p, b.daemon.d2p)).toBe(false)
    expect(bytesEqual(a.daemon.p2d, b.daemon.p2d)).toBe(false)
    // seq resets to 0 in each session — only safe because the key is fresh.
    const sealerA = createSealer('d2p')
    const sealerB = createSealer('d2p')
    expect(sealerA.nextSeq).toBe(0)
    expect(sealerB.nextSeq).toBe(0)
  })
})

// ── HARDEN: length validation in deriveSession (harden minor §1.5) ─────────────
describe('deriveSession length validation (harden minor)', () => {
  test('a 31-byte pairingSecret throws RangeError', () => {
    const daemonSk = x25519.utils.randomSecretKey()
    const deviceSk = x25519.utils.randomSecretKey()
    expect(() =>
      deriveDaemonSession({
        daemonSecretKey: daemonSk,
        devicePublicKey: x25519.getPublicKey(deviceSk),
        daemonPublicKey: x25519.getPublicKey(daemonSk),
        pairingSecret: randomBytes(31),
        sessionSalt: randomBytes(32),
        ids: IDS,
      })
    ).toThrow(RangeError)
  })

  test('a 31-byte sessionSalt throws RangeError', () => {
    const daemonSk = x25519.utils.randomSecretKey()
    const deviceSk = x25519.utils.randomSecretKey()
    expect(() =>
      deriveDaemonSession({
        daemonSecretKey: daemonSk,
        devicePublicKey: x25519.getPublicKey(deviceSk),
        daemonPublicKey: x25519.getPublicKey(daemonSk),
        pairingSecret: randomBytes(PAIRING_SECRET_LEN),
        sessionSalt: randomBytes(31),
        ids: IDS,
      })
    ).toThrow(RangeError)
  })
})

// ── HARDEN: nonce desync class removed — args read from header (harden major R5) ─
describe('sealFrame/openFrame read streamId+seq from header bytes (harden major R5)', () => {
  test('changing the passed seq arg has no effect — header is the source of truth', () => {
    // The API no longer takes redundant streamId/seq args; the nonce is derived
    // from headerBytes alone. This test pins that an attacker cannot desync by
    // passing a divergent arg, because there is no such arg.
    const { daemon, device } = handshake()
    const header = fixedHeader(5, 3)
    const ct = sealFrame({
      key: daemon.d2p,
      direction: 'd2p',
      headerBytes: header,
      payload: new Uint8Array([7]),
    })
    // Opening with the same header (streamId=5, seq=3) succeeds.
    const pt = openFrame({ key: device.d2p, direction: 'd2p', headerBytes: header, ciphertext: ct })
    expect(pt[0]).toBe(7)
    // Opening with a header that claims a different streamId/seq fails closed via the AEAD reject.
    expect(() =>
      openFrame({
        key: device.d2p,
        direction: 'd2p',
        headerBytes: fixedHeader(5, 4),
        ciphertext: ct,
      })
    ).toThrow(/invalid tag/)
  })

  test('buildNonce embeds streamId@1..4 and seq@8..15 (matches header offsets 4 and 8)', () => {
    const n = buildNonce('d2p', 0x01020304, 0x05060708)
    expect(n[0]).toBe(0x01) // DIR_BYTE_D2P
    expect([n[1], n[2], n[3], n[4]]).toEqual([0x01, 0x02, 0x03, 0x04])
    // seq sits in the u64 slot; low 4 bytes carry the value, high 4 are zero.
    expect([n[8], n[9], n[10], n[11]]).toEqual([0, 0, 0, 0])
    expect([n[12], n[13], n[14], n[15]]).toEqual([0x05, 0x06, 0x07, 0x08])
  })
})
