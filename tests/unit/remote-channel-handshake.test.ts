import { randomBytes } from '@noble/ciphers/utils.js'
import { describe, expect, test } from 'vitest'
import { CONN_SALT_LEN, REMOTE_CRYPTO_VERSION } from '../../src/shared/remote-crypto.js'
import {
  CHANNEL_DISC,
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  createStreamIdAllocator,
  decodeConnSalt,
  decodeHello,
  encodeConnSalt,
  encodeHello,
  type HelloMeta,
  isConnSaltPayload,
  ProtocolError,
} from '../../src/shared/remote-protocol.js'

// M6.1 channel-handshake encoding: the UNSEALED bilateral ConnSalt + the sealed binding Hello.

describe('ConnSalt codec', () => {
  test('round-trips role + 32-byte salt (device)', () => {
    const salt = randomBytes(CONN_SALT_LEN)
    const enc = encodeConnSalt({ role: 'device', salt })
    expect(enc.length).toBe(34)
    expect(enc[0]).toBe(CHANNEL_DISC.ConnSalt)
    const dec = decodeConnSalt(enc)
    expect(dec.role).toBe('device')
    expect(Array.from(dec.salt)).toEqual(Array.from(salt))
  })

  test('round-trips role daemon', () => {
    const salt = randomBytes(CONN_SALT_LEN)
    expect(decodeConnSalt(encodeConnSalt({ role: 'daemon', salt })).role).toBe('daemon')
  })

  test('decode throws ProtocolError on wrong length', () => {
    expect(() => decodeConnSalt(new Uint8Array(33))).toThrow(ProtocolError)
    expect(() => decodeConnSalt(new Uint8Array(35))).toThrow(ProtocolError)
  })

  test('decode throws on wrong disc byte', () => {
    const p = new Uint8Array(34)
    p[0] = 0x02 // Hello disc, not ConnSalt
    p[1] = 0x02
    expect(() => decodeConnSalt(p)).toThrow(ProtocolError)
  })

  test('decode throws on bad role byte', () => {
    const p = new Uint8Array(34)
    p[0] = CHANNEL_DISC.ConnSalt
    p[1] = 0x09 // not daemon (1) or device (2)
    expect(() => decodeConnSalt(p)).toThrow(ProtocolError)
  })

  test('encode rejects a non-32-byte salt', () => {
    expect(() => encodeConnSalt({ role: 'device', salt: new Uint8Array(31) })).toThrow(RangeError)
  })
})

describe('Hello disc prefix', () => {
  test('encode prepends the Hello disc; decode strips it and round-trips', () => {
    const m: HelloMeta = {
      protocolVersion: REMOTE_CRYPTO_VERSION,
      role: 'device',
      daemonId: 'daemon-A',
      deviceId: 'device-1',
    }
    const enc = encodeHello(m)
    expect(enc[0]).toBe(CHANNEL_DISC.Hello)
    expect(decodeHello(enc)).toEqual(m)
  })

  test('decodeHello rejects a payload missing the disc', () => {
    const json = new TextEncoder().encode(
      JSON.stringify({
        protocolVersion: REMOTE_CRYPTO_VERSION,
        role: 'device',
        daemonId: 'a',
        deviceId: 'b',
      })
    )
    // no disc prefix — should be rejected, not parsed as a bare JSON Hello
    expect(() => decodeHello(json)).toThrow(ProtocolError)
  })
})

describe('demux discriminator safety (HARDEN blocker)', () => {
  // The sealed Hello rides CHANNEL_STREAM_ID; its ciphertext byte 0 is uniform-random. If the demux
  // routed streamId-0 frames into the ConnSalt path whenever byte 0 === 0x01, ~1/256 sealed Hellos
  // would be eaten. The fix routes ConnSalt onto its OWN reserved stream id, so a sealed channel
  // frame whose ciphertext happens to start with 0x01 stays on the sealed path.
  test('CONN_SALT_STREAM_ID is distinct from CHANNEL_STREAM_ID', () => {
    expect(CONN_SALT_STREAM_ID).not.toBe(CHANNEL_STREAM_ID)
  })

  test('a random ciphertext starting with 0x01 is NOT routed as ConnSalt by stream id', () => {
    // The engines branch on header.streamId === CONN_SALT_STREAM_ID, not on payload[0]. Demonstrate
    // that many random "ciphertexts" with byte0===0x01 would be misrouted if byte0 were the demux.
    let firstByteIsConnSaltDisc = 0
    for (let i = 0; i < 4000; i++) {
      const ct = randomBytes(48)
      ct[0] = CHANNEL_DISC.ConnSalt // force the worst case
      if (isConnSaltPayload(ct)) firstByteIsConnSaltDisc++
    }
    // isConnSaltPayload alone would flag every one of these as ConnSalt…
    expect(firstByteIsConnSaltDisc).toBe(4000)
    // …which is exactly why a streamId-0 (channel) frame must be demuxed by stream id, never by
    // this byte. The reserved stream id makes that demux unambiguous.
    expect(CONN_SALT_STREAM_ID).not.toBe(CHANNEL_STREAM_ID)
  })

  test('the stream-id allocator never returns CONN_SALT_STREAM_ID or CHANNEL_STREAM_ID', () => {
    for (const side of ['daemon', 'device'] as const) {
      const alloc = createStreamIdAllocator(side)
      for (let i = 0; i < 5000; i++) {
        const id = alloc()
        expect(id).not.toBe(CONN_SALT_STREAM_ID)
        expect(id).not.toBe(CHANNEL_STREAM_ID)
      }
    }
  })
})
