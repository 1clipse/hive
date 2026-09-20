// @vitest-environment jsdom
//
// M6.1 PHONE rekey — transport layer. Proves the connection/Hello lifecycle re-keys on every fresh
// transport (a page reload builds a fresh createTunnelTransport ⇒ fresh mux ⇒ fresh beginChannel with
// a freshly drawn phoneConnSalt). The REAL createTunnelTransport + REAL frame-mux + REAL crypto run;
// only the relay WebSocket is a fake send-sink (a TunnelTransportDeps seam, not a crypto mock).

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  deriveDeviceSession,
  type HandshakeIds,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
} from '../../src/shared/remote-crypto.js'
import {
  CONN_SALT_STREAM_ID,
  decodeConnSalt,
  decodeHeader,
  HEADER_BYTES,
  isConnSaltPayload,
} from '../../src/shared/remote-protocol.js'
import {
  createTunnelTransport,
  type TunnelSession,
} from '../../web/src/transport/tunnel-transport.js'

afterEach(() => {
  vi.restoreAllMocks()
})

// non-null access without a bang (keeps biome's noNonNullAssertion quiet). The trailing comma in
// <T,> disambiguates the generic from JSX in a .tsx file.
const nth = <T,>(arr: T[], i: number): T => {
  const v = arr.at(i)
  if (v === undefined) throw new Error(`index ${i} out of range (len ${arr.length})`)
  return v
}

const ids = (): HandshakeIds => ({
  daemonId: 'daemon-rekey',
  deviceId: 'device-rekey-1',
  protocolVersion: REMOTE_CRYPTO_VERSION,
})

const makeRoots = (): { d2p: Uint8Array; p2d: Uint8Array } => {
  const id = ids()
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

// The minimal fake relay socket the transport opens: captures the frames the phone sends and lets the
// test observe the channel-open ConnSalt. Each FakeWebSocket instance registers itself globally so the
// per-lifecycle test can read what THAT transport sent.
const sentFramesPerInstance: Uint8Array[][] = []

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readonly OPEN = 1
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  url: string
  private mine: Uint8Array[]

  constructor(url: string) {
    this.url = url
    this.mine = []
    sentFramesPerInstance.push(this.mine)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') return // heartbeat ping text — ignore
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength
            )
    this.mine.push(Uint8Array.from(bytes))
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
}

const makeSession = (roots: { d2p: Uint8Array; p2d: Uint8Array }): TunnelSession => ({
  roots,
  deviceId: 'device-rekey-1',
  daemonId: 'daemon-rekey',
  gatewayUrl: 'wss://app.hivehq.dev',
  phoneSessionToken: 'phone-jwt-token',
})

// Extract the (single) device ConnSalt the transport emitted on a given instance's wire.
const connSaltOf = (frames: Uint8Array[]): Uint8Array => {
  for (const f of frames) {
    const header = decodeHeader(f.subarray(0, HEADER_BYTES))
    const payload = f.subarray(HEADER_BYTES)
    if (header.streamId === CONN_SALT_STREAM_ID && isConnSaltPayload(payload)) {
      const msg = decodeConnSalt(payload)
      if (msg.role === 'device') return msg.salt
    }
  }
  throw new Error('no device ConnSalt frame found on the wire')
}

describe('TunnelTransport rekey — fresh phoneConnSalt per connection lifecycle', () => {
  // D3 — the Hello lifecycle re-keys on each connection. Two lifecycles (a fresh createTunnelTransport
  // models a page reload) over the SAME root must emit DIFFERENT phoneConnSalt bytes on the channel
  // open. Catches a transport deriving connKey once at module load and reusing it forever.
  test('D3: two transport lifecycles over one root draw different phoneConnSalts', async () => {
    sentFramesPerInstance.length = 0
    const roots = makeRoots()

    const t1 = createTunnelTransport({
      session: makeSession(roots),
      onStatus: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    await Promise.resolve()
    await Promise.resolve()
    const salt1 = connSaltOf(nth(sentFramesPerInstance, -1))
    t1.dispose()

    const t2 = createTunnelTransport({
      session: makeSession(roots),
      onStatus: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    await Promise.resolve()
    await Promise.resolve()
    const salt2 = connSaltOf(nth(sentFramesPerInstance, -1))
    t2.dispose()

    expect(salt1.length).toBe(32)
    expect(salt2.length).toBe(32)
    // a fresh lifecycle MUST draw a fresh phone salt — never the same bytes
    expect(Array.from(salt1)).not.toEqual(Array.from(salt2))
  })

  // D3b — the channel open emits the UNSEALED ConnSalt before any sealed frame. (The Hello can only
  // be sealed after the daemon answers with its salt, which this fake never does, so the wire should
  // carry exactly the unsealed ConnSalt and no sealed channel/data frame.)
  test('D3b: onUp emits an unsealed device ConnSalt as the channel open', async () => {
    sentFramesPerInstance.length = 0
    const roots = makeRoots()
    const t = createTunnelTransport({
      session: makeSession(roots),
      onStatus: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    await Promise.resolve()
    await Promise.resolve()
    const frames = nth(sentFramesPerInstance, -1)
    expect(frames.length).toBeGreaterThan(0)
    const first = nth(frames, 0)
    const header = decodeHeader(first.subarray(0, HEADER_BYTES))
    expect(header.streamId).toBe(CONN_SALT_STREAM_ID)
    expect(isConnSaltPayload(first.subarray(HEADER_BYTES))).toBe(true)
    expect(decodeConnSalt(first.subarray(HEADER_BYTES)).role).toBe('device')
    t.dispose()
  })
})
