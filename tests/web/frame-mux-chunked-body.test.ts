// @vitest-environment jsdom
//
// Tunnel HTTP bodies must be CHUNKED. The gateway relay (a Cloudflare Durable Object) enforces a
// 1 MiB per-WebSocket-message cap, so the historical single-Data-frame body send meant any phone
// upload past ~1 MiB (every photo/video evidence upload) died at the relay. These tests drive the
// REAL createFrameMux with REAL crypto: the relay `send` sink is a capture array, the daemon salt is
// injected, and the captured sealed frames are opened with the recomputed per-connection key — so
// the assertions are on the true wire bytes, not on a mock's bookkeeping.

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'
import {
  createOpener,
  deriveConnectionKeys,
  deriveDeviceSession,
  type HandshakeIds,
  openNext,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
} from '../../src/shared/remote-crypto.js'
import {
  CONN_SALT_STREAM_ID,
  decodeConnSalt,
  decodeHeader,
  decodeHttpData,
  encodeConnSalt,
  encodeHeader,
  FrameKind,
  HEADER_BYTES,
  isConnSaltPayload,
} from '../../src/shared/remote-protocol.js'
import { createFrameMux, HTTP_BODY_CHUNK_BYTES } from '../../web/src/transport/frame-mux.js'

const ids = (): HandshakeIds => ({
  daemonId: 'daemon-chunk',
  deviceId: 'device-chunk-1',
  protocolVersion: REMOTE_CRYPTO_VERSION,
})

const makeRoot = (id: HandshakeIds): { d2p: Uint8Array; p2d: Uint8Array } => {
  const pairingSecret = randomBytes(PAIRING_SECRET_LEN)
  const sessionSalt = randomBytes(32)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const phone = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: x25519.getPublicKey(daemonSk),
    devicePublicKey: x25519.getPublicKey(deviceSk),
    pairingSecret,
    sessionSalt,
    ids: id,
  })
  return { d2p: phone.d2p, p2d: phone.p2d }
}

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

const flushUntil = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('flushUntil: condition not reached')
}

interface Harness {
  mux: ReturnType<typeof createFrameMux>
  frames: Uint8Array[]
  drainCalls: () => number
  /** Open every sealed frame captured after the handshake, in seq order, with the recomputed key. */
  openAll: () => Array<{ kind: FrameKind; streamId: number; plaintext: Uint8Array }>
}

const setUpMux = (drain?: { gate: () => Promise<void> }): Harness => {
  const id = ids()
  const root = makeRoot(id)
  const frames: Uint8Array[] = []
  let drainCount = 0
  const mux = createFrameMux({
    roots: root,
    daemonId: id.daemonId,
    deviceId: id.deviceId,
    send: (frame) => frames.push(Uint8Array.from(frame)),
    awaitDrain: () => {
      drainCount += 1
      return drain ? drain.gate() : Promise.resolve()
    },
  })
  mux.beginChannel()

  // The first emitted frame is the UNSEALED phone ConnSalt — capture it for key recomputation.
  const saltFrame = frames[0]
  if (!saltFrame) throw new Error('no phone ConnSalt emitted')
  const phonePayload = saltFrame.subarray(HEADER_BYTES)
  if (!isConnSaltPayload(phonePayload)) throw new Error('first frame is not a ConnSalt')
  const phoneConnSalt = decodeConnSalt(phonePayload).salt

  const daemonConnSalt = randomBytes(32)
  mux.onFrame(daemonConnSaltFrame(daemonConnSalt))

  const connKeys = deriveConnectionKeys({
    rootD2p: root.d2p,
    rootP2d: root.p2d,
    phoneConnSalt,
    daemonConnSalt,
    ids: id,
  })

  const openAll = () => {
    const opener = createOpener('p2d')
    const out: Array<{ kind: FrameKind; streamId: number; plaintext: Uint8Array }> = []
    for (const frame of frames) {
      const headerBytes = frame.subarray(0, HEADER_BYTES)
      const header = decodeHeader(headerBytes)
      if (header.streamId === CONN_SALT_STREAM_ID) continue
      const plaintext = openNext(opener, {
        key: connKeys.p2d,
        streamId: header.streamId,
        headerBytes,
        ciphertext: frame.subarray(HEADER_BYTES),
        seq: header.seq,
      })
      out.push({ kind: header.kind, streamId: header.streamId, plaintext })
    }
    return out
  }

  return { mux, frames, drainCalls: () => drainCount, openAll }
}

describe('frame-mux — chunked HTTP request bodies', () => {
  test('a multi-chunk body crosses the wire as bounded Data frames that reassemble byte-for-byte', async () => {
    const h = setUpMux()
    // 2.5 chunks so the tail chunk is a partial — exercises the subarray bounds.
    const body = new Uint8Array(Math.floor(HTTP_BODY_CHUNK_BYTES * 2.5))
    for (let i = 0; i < body.length; i++) body[i] = i % 251

    void h.mux.fetch('/api/workspaces/w1/uploads', { method: 'POST', body })
    const expectedChunks = Math.ceil(body.length / HTTP_BODY_CHUNK_BYTES)
    await flushUntil(() => {
      const opened = h.openAll().filter((f) => f.streamId !== 0)
      return opened.some((f) => f.kind === FrameKind.End)
    })

    // Relay-cap property: no single frame may approach the DO's 1 MiB message limit.
    for (const frame of h.frames) {
      expect(frame.byteLength).toBeLessThan(HTTP_BODY_CHUNK_BYTES + 1024)
    }

    const opened = h.openAll().filter((f) => f.streamId !== 0) // drop the channel Hello
    expect(opened.map((f) => f.kind)).toEqual([
      FrameKind.Open,
      ...Array.from({ length: expectedChunks }, () => FrameKind.Data),
      FrameKind.End,
    ])

    // Byte-for-byte reassembly of the decrypted chunks against the original body.
    const reassembled = new Uint8Array(body.length)
    let offset = 0
    for (const frame of opened) {
      if (frame.kind !== FrameKind.Data) continue
      const decoded = decodeHttpData(frame.plaintext)
      if (decoded.kind !== 'body') throw new Error('request-side frame decoded as a head')
      reassembled.set(decoded.data, offset)
      offset += decoded.data.length
    }
    expect(offset).toBe(body.length)
    expect(Buffer.from(reassembled).equals(Buffer.from(body))).toBe(true)

    // Pacing seam: awaited between chunks (not before the first one).
    expect(h.drainCalls()).toBe(expectedChunks - 1)
  })

  test('a small body stays on the synchronous single-frame path', () => {
    const h = setUpMux()
    void h.mux.fetch('/api/workspaces/w1/uploads', { method: 'POST', body: 'hello' })
    // Synchronous: Open + Data + End are already on the wire, no drain consulted.
    const opened = h.openAll().filter((f) => f.streamId !== 0)
    expect(opened.map((f) => f.kind)).toEqual([FrameKind.Open, FrameKind.Data, FrameKind.End])
    expect(h.drainCalls()).toBe(0)
  })

  test('resetAll mid-body stops the chunk loop: the fetch rejects and no End follows', async () => {
    let release: (() => void) | undefined
    const gate = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const h = setUpMux({ gate })
    const body = new Uint8Array(HTTP_BODY_CHUNK_BYTES * 3)

    const fetchPromise = h.mux.fetch('/api/workspaces/w1/uploads', { method: 'POST', body })
    const rejection = expect(fetchPromise).rejects.toThrow(/connection lost/)
    await flushUntil(() => release !== undefined) // first chunk sent; loop parked on the drain gate

    const framesBeforeReset = h.frames.length
    h.mux.resetAll('socket dropped')
    release?.()
    await rejection

    // Give the (now dead) loop every chance to misbehave, then assert it sent nothing further.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.frames.length).toBe(framesBeforeReset)
  })
})
