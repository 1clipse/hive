// @vitest-environment jsdom
//
// M6.1 PHONE rekey — frame-mux layer. The vulnerability: a page reload builds a FRESH mux (seq 0,
// streamId 1) over the SAME persisted device root, so the very first sealed frame (the channel Hello
// on streamId 0, seq 0) reuses nonce(p2d, 0, 0) under the same p2d key as the previous page load.
// XChaCha20-Poly1305 nonce reuse under one key = catastrophic.
//
// The fix: the persisted d2p/p2d are ROOTS, never an AEAD key. On every fresh mux we draw a phone
// connection salt, exchange it unsealed, and derive a per-connection connKey = HKDF(root, phoneSalt
// || daemonSalt, ...). Every sealed frame (incl the binding Hello) uses connKey from seq 0. A reload
// draws a fresh phone salt + sees a fresh daemon salt ⇒ a different connKey ⇒ no nonce reuse.
//
// These tests drive the REAL createFrameMux with REAL crypto. Nothing is mocked — only the relay
// `send` sink is a capture array and `generateConnSalt` is injected so the test can recompute the
// connKey and the buildNonce for each sealed frame it observes. The recorder observes the REAL key +
// REAL header (NOT a mock) and asserts zero (key, nonce) dupes across two muxes built from one root.

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'
import {
  deriveDeviceSession,
  type HandshakeIds,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
} from '../../src/shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  decodeConnSalt,
  decodeHeader,
  encodeConnSalt,
  encodeHeader,
  FrameKind,
  HEADER_BYTES,
  isConnSaltPayload,
} from '../../src/shared/remote-protocol.js'
import { createFrameMux } from '../../web/src/transport/frame-mux.js'
import { createSealRecorder } from '../helpers/seal-recorder.js'

// non-null array access without a bang (keeps biome's noNonNullAssertion quiet)
const nth = <T>(arr: T[], i: number): T => {
  const v = arr.at(i)
  if (v === undefined) throw new Error(`index ${i} out of range (len ${arr.length})`)
  return v
}

const ids = (deviceId = 'device-rekey-1', daemonId = 'daemon-rekey'): HandshakeIds => ({
  daemonId,
  deviceId,
  protocolVersion: REMOTE_CRYPTO_VERSION,
})

// Derive a real phone root (d2p/p2d) so connKey derivation has genuine root material.
const makeRoot = (id: HandshakeIds): { d2p: Uint8Array; p2d: Uint8Array } => {
  const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = randomBytes(32)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const daemonPk = x25519.getPublicKey(daemonSk)
  const devicePk = x25519.getPublicKey(deviceSk)
  const phone = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids: id,
  })
  return { d2p: phone.d2p, p2d: phone.p2d }
}

// A daemon ConnSalt frame the test pushes back to the mux to complete the handshake.
const daemonConnSaltFrame = (salt: Uint8Array): Uint8Array => {
  const header = encodeHeader({
    version: REMOTE_CRYPTO_VERSION,
    kind: FrameKind.Data,
    flags: 0,
    streamId: CONN_SALT_STREAM_ID,
    seq: 0,
  })
  const body = encodeConnSalt({ role: 'daemon', salt })
  const frame = new Uint8Array(header.length + body.length)
  frame.set(header, 0)
  frame.set(body, header.length)
  return frame
}

describe('frame-mux rekey — per-connection connKey, no nonce reuse on reload', () => {
  // D1 — CENTERPIECE (mux layer). Two FRESH muxes over the SAME root (a page reload), each drawing a
  // distinct phoneConnSalt and seeing a distinct daemonConnSalt. Record every (real key, real nonce)
  // the mux actually seals — the Hello on (0,0) plus a fetch on stream 1 — across BOTH muxes. Assert
  // zero (key, nonce) dupes. On the pre-fix code the Hello seals under the raw root at nonce(p2d,0,0)
  // in BOTH muxes ⇒ a duplicate ⇒ this is RED before the fix.
  test('D1: two fresh muxes from one root never reuse a (key, nonce) tuple', () => {
    const id = ids()
    const root = makeRoot(id)
    const recorder = createSealRecorder()

    const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16)).join('')
    const rootKeys = new Set([hex(root.d2p), hex(root.p2d)])

    const runConnection = (phoneSalt: Uint8Array, daemonSalt: Uint8Array): void => {
      const sent: Uint8Array[] = []
      const mux = createFrameMux({
        roots: { d2p: root.d2p, p2d: root.p2d },
        daemonId: id.daemonId,
        deviceId: id.deviceId,
        send: (f) => sent.push(f),
        generateConnSalt: () => phoneSalt,
        // observe the REAL key + REAL header the production seal path used (NOT a mock). Recording via
        // the hook (rather than a recomputed connKey) makes the no-downgrade property mutation-tested:
        // if the mux ever sealed under the root, the recorded key would equal a root below.
        onSeal: (rec) => {
          // no frame is EVER sealed under the persisted root — the whole point of the rekey
          expect(rootKeys.has(hex(rec.key))).toBe(false)
          recorder.record(rec)
        },
      })

      mux.beginChannel() // draws phoneSalt, sends the UNSEALED ConnSalt
      // first frame out is the unsealed device ConnSalt — NOT sealed (no onSeal fires for it)
      const firstHeader = decodeHeader(nth(sent, 0).subarray(0, HEADER_BYTES))
      expect(firstHeader.streamId).toBe(CONN_SALT_STREAM_ID)
      const firstPayload = nth(sent, 0).subarray(HEADER_BYTES)
      expect(isConnSaltPayload(firstPayload)).toBe(true)
      expect(decodeConnSalt(firstPayload).role).toBe('device')

      // daemon answers with its salt → mux derives connKeys, seals the binding Hello on (0,0)
      mux.onFrame(daemonConnSaltFrame(daemonSalt))
      // now issue a fetch so we also seal an Open/End on a data stream
      void mux.fetch('/api/workspaces')
    }

    runConnection(new Uint8Array(32).fill(0xa1), new Uint8Array(32).fill(0xb1))
    runConnection(new Uint8Array(32).fill(0xa2), new Uint8Array(32).fill(0xb2))

    expect(recorder.count()).toBeGreaterThan(0)
    // at minimum: Hello(0,0) + Open + End on stream 1, in both connections → 6 seals
    expect(recorder.count()).toBeGreaterThanOrEqual(4)
    expect(recorder.dupes()).toBe(0)
  })

  // D1-bite — prove the regression genuinely bites: if the rekey is REMOVED (the mux were to seal
  // under the raw root directly, as the pre-fix code did), the two reload Hellos collide. We model
  // that by recording under the ROOT key for both connections at the channel Hello's (0,0) header.
  test('D1-bite: sealing under the raw root reuses (root, nonce(p2d,0,0)) across reloads', () => {
    const id = ids()
    const root = makeRoot(id)
    const recorder = createSealRecorder()
    const helloHeader = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: CHANNEL_STREAM_ID,
      seq: 0,
    })
    // two reloads, both sealing the Hello on (0,0) under the SAME persisted root
    recorder.record({ key: root.p2d, direction: 'p2d', headerBytes: helloHeader })
    recorder.record({ key: root.p2d, direction: 'p2d', headerBytes: helloHeader })
    expect(recorder.dupes()).toBeGreaterThan(0)
  })

  // D2 — resetAll must NOT reset the sealer/opener/connKeys/allocator. In-page reconnect re-arms via
  // beginChannel() on peer-online; resetAll alone only fails in-flight streams and must keep seq
  // monotonic (so an over-eager fix that rewinds seq to 0 without a fresh salt exchange is caught).
  test('D2: resetAll keeps seq monotonic and does not rewind the allocator', () => {
    const id = ids()
    const root = makeRoot(id)
    const phoneSalt = new Uint8Array(32).fill(0x11)
    const daemonSalt = new Uint8Array(32).fill(0x22)
    const sent: Uint8Array[] = []
    const mux = createFrameMux({
      roots: { d2p: root.d2p, p2d: root.p2d },
      daemonId: id.daemonId,
      deviceId: id.deviceId,
      send: (f) => sent.push(f),
      generateConnSalt: () => phoneSalt,
    })
    mux.beginChannel()
    mux.onFrame(daemonConnSaltFrame(daemonSalt)) // seals Hello on (0,0)

    // resetAll rejects the in-flight fetch — swallow the expected rejection so it isn't unhandled.
    mux.fetch('/api/a').catch(() => {}) // Open+End on stream 1
    const afterFirstFetch = sent.length
    mux.resetAll('peer_offline') // must NOT touch sealer/opener/connKeys/allocStreamId
    mux.fetch('/api/b').catch(() => {}) // Open+End on stream 3, seq continues monotonically

    // collect seqs + streamIds of the sealed Open frames
    const opens: { streamId: number; seq: number }[] = []
    for (let i = 1; i < sent.length; i++) {
      const h = decodeHeader(nth(sent, i).subarray(0, HEADER_BYTES))
      if (h.kind === FrameKind.Open) opens.push({ streamId: h.streamId, seq: h.seq })
    }
    expect(opens.length).toBe(2)
    // second Open uses a NEW stream id (allocator not rewound) and a HIGHER seq (sealer not rewound)
    expect(nth(opens, 1).streamId).toBeGreaterThan(nth(opens, 0).streamId)
    expect(nth(opens, 1).seq).toBeGreaterThan(nth(opens, 0).seq)
    expect(sent.length).toBeGreaterThan(afterFirstFetch)
  })

  test('D2b: duplicate daemon ConnSalt is a no-op and does not rewind the phone sealer', () => {
    const id = ids()
    const root = makeRoot(id)
    const phoneSalt = new Uint8Array(32).fill(0x66)
    const daemonSalt = new Uint8Array(32).fill(0x77)
    const sent: Uint8Array[] = []
    let readyCount = 0
    const mux = createFrameMux({
      roots: { d2p: root.d2p, p2d: root.p2d },
      daemonId: id.daemonId,
      deviceId: id.deviceId,
      send: (f) => sent.push(f),
      generateConnSalt: () => phoneSalt,
      onReady: () => {
        readyCount += 1
      },
    })
    mux.beginChannel()
    mux.onFrame(daemonConnSaltFrame(daemonSalt)) // Hello seq 0
    mux.fetch('/api/first').catch(() => {}) // Open+End on stream 1, seq advances
    const sentAfterFirstFetch = sent.length

    // The real relay/daemon path can deliver the same daemon salt twice on one
    // socket: once from attachSocket and once re-emitted after the phone salt.
    // It must NOT reset sealer/opener or send another Hello.
    mux.onFrame(daemonConnSaltFrame(daemonSalt))
    expect(sent.length).toBe(sentAfterFirstFetch)
    expect(readyCount).toBe(1)

    mux.fetch('/api/second').catch(() => {}) // Open+End must continue, not rewind

    const hellos: { seq: number; streamId: number }[] = []
    const opens: { streamId: number; seq: number }[] = []
    for (let i = 1; i < sent.length; i++) {
      const h = decodeHeader(nth(sent, i).subarray(0, HEADER_BYTES))
      if (h.streamId === CHANNEL_STREAM_ID) hellos.push({ streamId: h.streamId, seq: h.seq })
      if (h.kind === FrameKind.Open) opens.push({ streamId: h.streamId, seq: h.seq })
    }

    expect(hellos).toEqual([{ streamId: CHANNEL_STREAM_ID, seq: 0 }])
    expect(opens.length).toBe(2)
    expect(nth(opens, 1).streamId).toBeGreaterThan(nth(opens, 0).streamId)
    expect(nth(opens, 1).seq).toBeGreaterThan(nth(opens, 0).seq)
  })

  // D4 — shape guard: the channel-open ConnSalt frame is UNSEALED (parses via decodeConnSalt with NO
  // key); the binding Hello is SEALED (its payload does NOT begin with the ConnSalt disc). Catches a
  // fix that seals the salt frame under the root at a fixed nonce (which would just relocate the reuse).
  test('D4: ConnSalt rides unsealed; the binding Hello is sealed (not a ConnSalt payload)', () => {
    const id = ids()
    const root = makeRoot(id)
    const phoneSalt = new Uint8Array(32).fill(0x33)
    const daemonSalt = new Uint8Array(32).fill(0x44)
    const sent: Uint8Array[] = []
    const mux = createFrameMux({
      roots: { d2p: root.d2p, p2d: root.p2d },
      daemonId: id.daemonId,
      deviceId: id.deviceId,
      send: (f) => sent.push(f),
      generateConnSalt: () => phoneSalt,
    })
    mux.beginChannel()

    // frame 0 is the UNSEALED ConnSalt: parses with no key, byte 0 is the ConnSalt disc.
    const saltFrame = nth(sent, 0)
    const saltHeader = decodeHeader(saltFrame.subarray(0, HEADER_BYTES))
    expect(saltHeader.streamId).toBe(CONN_SALT_STREAM_ID)
    const saltPayload = saltFrame.subarray(HEADER_BYTES)
    expect(isConnSaltPayload(saltPayload)).toBe(true)
    const decoded = decodeConnSalt(saltPayload)
    expect(decoded.role).toBe('device')
    expect(Array.from(decoded.salt)).toEqual(Array.from(phoneSalt))

    // daemon salt → mux seals the Hello on CHANNEL_STREAM_ID
    mux.onFrame(daemonConnSaltFrame(daemonSalt))
    const helloFrame = nth(sent, 1)
    const helloHeader = decodeHeader(helloFrame.subarray(0, HEADER_BYTES))
    expect(helloHeader.streamId).toBe(CHANNEL_STREAM_ID)
    expect(helloHeader.seq).toBe(0)
    // the sealed Hello's payload is ciphertext — its byte 0 must NOT be read as a ConnSalt disc by
    // the demux. The demux discriminates on streamId, never on this byte; assert the streamIds differ.
    expect(helloHeader.streamId).not.toBe(saltHeader.streamId)
  })

  // D5 — no seal before the handshake completes. fetch() before connKeys exist must reject (fail
  // closed), never seal under the root. Catches a downgrade-strip that falls back to the root key.
  test('D5: fetch before the salt exchange completes rejects (never seals under the root)', async () => {
    const id = ids()
    const root = makeRoot(id)
    const sent: Uint8Array[] = []
    const mux = createFrameMux({
      roots: { d2p: root.d2p, p2d: root.p2d },
      daemonId: id.daemonId,
      deviceId: id.deviceId,
      send: (f) => sent.push(f),
      generateConnSalt: () => new Uint8Array(32).fill(0x55),
    })
    mux.beginChannel() // ConnSalt sent, but no daemon salt yet → connKeys still null
    await expect(mux.fetch('/api/early')).rejects.toThrow()
    // only the unsealed ConnSalt went out; nothing was sealed under the root.
    expect(sent.length).toBe(1)
    expect(decodeHeader(nth(sent, 0).subarray(0, HEADER_BYTES)).streamId).toBe(CONN_SALT_STREAM_ID)
  })
})
