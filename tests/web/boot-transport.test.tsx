// @vitest-environment jsdom
//
// M5a STAGE 6 — boot wiring. The seam that selects the transport when the bundle boots:
//   - desktop (local runtime, loopback / no gateway flag): DirectTransport stays the default; nothing
//     is swapped, no tunnel code is touched. main.tsx mounts React immediately, unchanged.
//   - mobile (gateway-served bundle): the boot path hands the ConnectFlow a `connectTransport` that
//     builds a real TunnelTransport from the resolved device session and swaps it into api.ts via
//     setApiTransport — so every subsequent apiFetch / openWebSocket rides the E2E tunnel, not the
//     gateway origin.
//
// These tests use the REAL M1 crypto/protocol against an in-test daemon-side opener (the same shape as
// transport-tunnel.test.tsx) — only "the other end of the wire" is a fixture. Every assert fails if the
// product is reversed: a desktop boot that swaps in a tunnel, a mobile boot that leaves Direct active,
// or a connectTransport that hands back a transport whose sealed frames the daemon can't open.

import { randomBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type ConnectionKeys,
  createOpener,
  createSealer,
  deriveConnectionKeys,
  deriveDaemonSession,
  deriveDeviceSession,
  type FrameOpener,
  type FrameSealer,
  generateConnSalt,
  type HandshakeIds,
  openNext,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  sealNext,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'
import {
  CHANNEL_STREAM_ID,
  CONN_SALT_STREAM_ID,
  decodeConnSalt,
  decodeHeader,
  decodeOpenPayload,
  encodeConnSalt,
  encodeHeader,
  encodeHttpBodyChunk,
  encodeHttpHead,
  FrameKind,
  HEADER_BYTES,
  isConnSaltPayload,
  type StreamMeta,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'
import { getApiTransport, setApiTransport } from '../../web/src/api.js'
import {
  bootTransport,
  makeTunnelConnectTransport,
} from '../../web/src/transport/boot-transport.js'
import type { StoredDeviceSession } from '../../web/src/transport/device-session-store.js'
import { directTransport } from '../../web/src/transport/direct-transport.js'
import type { TunnelSession } from '../../web/src/transport/tunnel-transport.js'

// ── a real (phone, daemon) session pair, both halves exposed ─────────────────────────────────────

interface Pair {
  deviceId: string
  daemonId: string
  phone: { d2p: Uint8Array; p2d: Uint8Array }
  daemon: { d2p: Uint8Array; p2d: Uint8Array }
}

const makePair = (): Pair => {
  const deviceId = 'device-boot-1'
  const daemonId = 'daemon-boot'
  const ids: HandshakeIds = { daemonId, deviceId, protocolVersion: REMOTE_CRYPTO_VERSION }
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
    ids,
  })
  const phone = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids,
  })
  return {
    deviceId,
    daemonId,
    phone: { d2p: phone.d2p, p2d: phone.p2d },
    daemon: { d2p: daemon.d2p, p2d: daemon.p2d },
  }
}

// ── an in-memory relay wire + a daemon double that opens the phone's frames and seals a reply ─────

class ActiveWire {
  phone: FakeWebSocket | null = null
  frameCbs: ((f: Uint8Array) => void)[] = []
  attach(ws: FakeWebSocket): void {
    this.phone = ws
  }
  phoneSentFrame(f: Uint8Array): void {
    for (const cb of this.frameCbs) cb(f)
  }
  onPhoneFrame(cb: (f: Uint8Array) => void): void {
    this.frameCbs.push(cb)
  }
  pushToPhone(f: Uint8Array): void {
    this.phone?.deliver(f)
  }
}

let wire = new ActiveWire()

class FakeWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    wire.attach(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') return // heartbeat ping — ignore
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
    wire.phoneSentFrame(Uint8Array.from(bytes))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  deliver(frame: Uint8Array): void {
    if (this.readyState !== 1) return
    this.onmessage?.({
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    })
  }
}

let delayedSocket: DelayedWebSocket | null = null

class DelayedWebSocket {
  static OPEN = 1
  readonly OPEN = 1
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    delayedSocket = this
    wire.attach(this as unknown as FakeWebSocket)
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') return
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
    wire.phoneSentFrame(Uint8Array.from(bytes))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  deliver(frame: Uint8Array): void {
    if (this.readyState !== 1) return
    this.onmessage?.({
      data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
    })
  }
  openNow(): void {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.()
  }
}

// The daemon side: opens each phone frame with d2p-OPEN/p2d-OPEN keys, handles an Http Open by sealing
// a head+body+FIN back. Honors the request, so a working transport gets a real Response.
const startDaemonDouble = (
  pair: Pair,
  handler: (path: string) => { status: number; body: string }
) => {
  // M6.1: pair.daemon keys are ROOTS. Exchange the bilateral salt, derive per-connection connKeys,
  // and seal/open under connKeys — never the root.
  const dIds: HandshakeIds = {
    daemonId: pair.daemonId,
    deviceId: pair.deviceId,
    protocolVersion: REMOTE_CRYPTO_VERSION,
  }
  let daemonConnSalt: Uint8Array = generateConnSalt()
  let connKeys: ConnectionKeys | null = null
  let opener: FrameOpener | null = null // daemon OPENS what the phone SEALED with p2d
  let sealer: FrameSealer | null = null // daemon SEALS d2p for the phone to open
  wire.onPhoneFrame((frame) => {
    const headerBytes = frame.subarray(0, HEADER_BYTES)
    const header = decodeHeader(headerBytes)
    const ciphertext = frame.subarray(HEADER_BYTES)
    // UNSEALED device ConnSalt → arm connKeys + answer with the daemon salt.
    if (header.streamId === CONN_SALT_STREAM_ID && isConnSaltPayload(ciphertext)) {
      const msg = decodeConnSalt(ciphertext)
      if (msg.role !== 'device') return
      daemonConnSalt = generateConnSalt()
      connKeys = deriveConnectionKeys({
        rootD2p: pair.daemon.d2p,
        rootP2d: pair.daemon.p2d,
        phoneConnSalt: msg.salt,
        daemonConnSalt,
        ids: dIds,
      })
      opener = createOpener('p2d')
      sealer = createSealer('d2p')
      const sh = encodeHeader({
        version: REMOTE_CRYPTO_VERSION,
        kind: FrameKind.Data,
        flags: 0,
        streamId: CONN_SALT_STREAM_ID,
        seq: 0,
      })
      const sb = encodeConnSalt({ role: 'daemon', salt: daemonConnSalt })
      const sf = new Uint8Array(sh.length + sb.length)
      sf.set(sh, 0)
      sf.set(sb, sh.length)
      wire.pushToPhone(sf)
      return
    }
    if (!opener || !connKeys || !sealer) return // a sealed frame before the salt exchange — drop
    const sealerNonNull = sealer
    const connKeysNonNull = connKeys
    const plaintext = openNext(opener, {
      key: connKeysNonNull.p2d,
      streamId: header.streamId,
      headerBytes,
      ciphertext,
      seq: header.seq,
    })
    if (header.streamId === CHANNEL_STREAM_ID) return // the sealed Hello — bind only
    if (header.kind !== FrameKind.Open) return
    const meta = decodeOpenPayload(plaintext) as StreamMeta
    if (meta.transport !== StreamTransport.Http || !meta.http) return
    const { status, body } = handler(meta.http.path)
    const sealOut = (kind: FrameKind, payload: Uint8Array, flags = 0): Uint8Array => {
      const h = encodeHeader({
        version: REMOTE_CRYPTO_VERSION,
        kind,
        flags,
        streamId: header.streamId,
        seq: sealerNonNull.nextSeq,
      })
      const { ciphertext: ct } = sealNext(sealerNonNull, {
        key: connKeysNonNull.d2p,
        streamId: header.streamId,
        headerBytes: h,
        payload,
      })
      const out = new Uint8Array(h.length + ct.length)
      out.set(h, 0)
      out.set(ct, h.length)
      return out
    }
    wire.pushToPhone(
      sealOut(
        FrameKind.Data,
        encodeHttpHead({ status, headers: [['content-type', 'application/json']] })
      )
    )
    wire.pushToPhone(
      sealOut(FrameKind.Data, encodeHttpBodyChunk(new TextEncoder().encode(body)), 1)
    )
  })
}

const sessionFor = (pair: Pair): TunnelSession => ({
  roots: { d2p: pair.phone.d2p, p2d: pair.phone.p2d },
  deviceId: pair.deviceId,
  daemonId: pair.daemonId,
  gatewayUrl: 'wss://app.hivehq.dev',
  phoneSessionToken: 'phone-jwt',
})

const storedFor = (pair: Pair): StoredDeviceSession => ({
  v: 2,
  gatewayUrl: 'https://app.hivehq.dev',
  daemonId: pair.daemonId,
  deviceId: pair.deviceId,
  deviceKeyPair: { secretKey: 'c2s', publicKey: 'cGs' },
  daemonPublicKey: 'ZHBr',
  rootKeys: { d2p: toBase64Url(pair.phone.d2p), p2d: toBase64Url(pair.phone.p2d) },
  protocolVersion: REMOTE_CRYPTO_VERSION,
  pairedAt: 1,
})

beforeEach(() => {
  wire = new ActiveWire()
  delayedSocket = null
  setApiTransport(directTransport) // restore the default before every test
})

afterEach(() => {
  setApiTransport(directTransport)
  vi.restoreAllMocks()
})

describe('bootTransport — desktop (DirectTransport stays default, additive)', () => {
  // W1 — on a loopback host with no gateway flag, the boot returns mode:'direct' and never swaps the
  // active transport. Fails if a desktop boot installs the tunnel.
  test('a non-gateway bundle keeps DirectTransport active and reports mode direct', () => {
    expect(window.location.hostname).toBe('localhost') // jsdom default — a loopback host
    const result = bootTransport({ isGateway: () => false })
    expect(result.mode).toBe('direct')
    // The active transport is unchanged — still the literal directTransport.
    expect(getApiTransport()).toBe(directTransport)
  })

  // W2 — the desktop boot never constructs a tunnel: it must not require any session/connect deps.
  test('the desktop boot needs no session or connect deps', () => {
    expect(() => bootTransport({ isGateway: () => false })).not.toThrow()
    // and it still leaves Direct in place
    expect(getApiTransport()).toBe(directTransport)
  })
})

describe('bootTransport — mobile (gateway bundle exposes the tunnel connect seam)', () => {
  // W3 — a gateway bundle returns mode:'tunnel' and a connectTransport the ConnectFlow can call. The
  // active transport is NOT swapped at boot (the swap happens only after a daemon is selected/paired),
  // so an unselected mobile boot still has DirectTransport (no half-open tunnel with no session).
  test('a gateway bundle reports mode tunnel and surfaces a connectTransport without swapping yet', () => {
    const result = bootTransport({
      isGateway: () => true,
      resolveSession: async () => sessionFor(makePair()),
    })
    expect(result.mode).toBe('tunnel')
    if (result.mode !== 'tunnel') throw new Error('unreachable')
    expect(typeof result.connectTransport).toBe('function')
    // boot alone does not install a tunnel — Direct is still active until a daemon is chosen.
    expect(getApiTransport()).toBe(directTransport)
  })

  // W4 — calling the surfaced connectTransport builds a REAL TunnelTransport from the resolved session
  // and swaps it into api.ts: a subsequent getApiTransport().fetch rides the E2E tunnel and the daemon
  // double can open the sealed frames + the reassembled Response is real. Fails if connectTransport
  // leaves Direct active, or builds a transport whose frames the daemon can't open (wrong keys).
  test('connectTransport installs a working TunnelTransport that the daemon double can open', async () => {
    const pair = makePair()
    startDaemonDouble(pair, (path) => ({
      status: path === '/api/workspaces' ? 200 : 404,
      body: JSON.stringify({ path }),
    }))

    const result = bootTransport({
      isGateway: () => true,
      resolveSession: async () => sessionFor(pair),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    if (result.mode !== 'tunnel') throw new Error('expected tunnel mode')

    const connectResult = await result.connectTransport({
      daemonId: pair.daemonId,
      deviceId: pair.deviceId,
      stored: storedFor(pair),
    })
    expect(connectResult.ok).toBe(true)

    // The active transport is now the tunnel — Direct was swapped out.
    expect(getApiTransport()).not.toBe(directTransport)

    // A fetch can run immediately after connectTransport returns: it has already waited for the
    // bilateral channel handshake, so the first app bootstrap request cannot hit "channel not ready".
    const res = await getApiTransport().fetch('/api/workspaces')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ path: '/api/workspaces' })
  })

  test('connectTransport waits for channel readiness before swapping the active transport', async () => {
    const pair = makePair()
    startDaemonDouble(pair, (path) => ({
      status: 200,
      body: JSON.stringify({ path }),
    }))

    const result = bootTransport({
      isGateway: () => true,
      resolveSession: async () => sessionFor(pair),
      WebSocketImpl: DelayedWebSocket as unknown as typeof WebSocket,
    })
    if (result.mode !== 'tunnel') throw new Error('expected tunnel mode')

    let settled = false
    const connectPromise = result
      .connectTransport({
        daemonId: pair.daemonId,
        deviceId: pair.deviceId,
        stored: storedFor(pair),
      })
      .then((out) => {
        settled = true
        return out
      })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(getApiTransport()).toBe(directTransport)

    const socket = delayedSocket
    if (!socket) throw new Error('delayed socket was not created')
    socket.openNow()

    const connectResult = await connectPromise
    expect(connectResult.ok).toBe(true)
    expect(getApiTransport()).not.toBe(directTransport)

    const res = await getApiTransport().fetch('/api/workspaces')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ path: '/api/workspaces' })
  })

  // W5 — connectTransport routes session resolution through the injected resolveSession with the
  // selected daemon/device — the genuinely-deferred crypto seam (§9). Fails if it ignores the selection
  // or never asks for a session.
  test('connectTransport resolves the session for the selected daemon/device', async () => {
    const pair = makePair()
    startDaemonDouble(pair, () => ({ status: 200, body: '{}' }))
    const seen: Array<{ daemonId: string; deviceId: string; stored: StoredDeviceSession | null }> =
      []

    const result = bootTransport({
      isGateway: () => true,
      resolveSession: async (input) => {
        seen.push(input)
        return sessionFor(pair)
      },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    if (result.mode !== 'tunnel') throw new Error('expected tunnel mode')

    const stored = storedFor(pair)
    await result.connectTransport({ daemonId: pair.daemonId, deviceId: pair.deviceId, stored })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.daemonId).toBe(pair.daemonId)
    expect(seen[0]?.deviceId).toBe(pair.deviceId)
    expect(seen[0]?.stored).toBe(stored)
  })

  // W6 — if resolveSession rejects (no session material — e.g. the deferred silent-rebuild can't derive
  // keys), connectTransport returns a select_failed result and does NOT swap in a broken transport.
  test('a failed session resolution returns select_failed and leaves Direct active', async () => {
    const result = bootTransport({
      isGateway: () => true,
      resolveSession: async () => {
        throw new Error('no key material for this daemon')
      },
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    if (result.mode !== 'tunnel') throw new Error('expected tunnel mode')

    const connectResult = await result.connectTransport({
      daemonId: 'daemon-x',
      deviceId: 'device-x',
      stored: null,
    })
    expect(connectResult.ok).toBe(false)
    if (!connectResult.ok) expect(connectResult.failure.code).toBe('select_failed')
    // a broken resolution must not swap the active transport
    expect(getApiTransport()).toBe(directTransport)
  })
})

describe('makeTunnelConnectTransport — the connectTransport factory in isolation', () => {
  // W7 — the factory alone (without the boot wrapper) builds + installs a tunnel and reports onStatus.
  test('installs the tunnel and forwards status updates', async () => {
    const pair = makePair()
    startDaemonDouble(pair, () => ({ status: 200, body: '{"ok":true}' }))
    const statuses: string[] = []

    const connectTransport = makeTunnelConnectTransport({
      resolveSession: async () => sessionFor(pair),
      onStatus: (s) => statuses.push(s.state),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })

    const out = await connectTransport({
      daemonId: pair.daemonId,
      deviceId: pair.deviceId,
      stored: storedFor(pair),
    })
    expect(out.ok).toBe(true)
    expect(getApiTransport()).not.toBe(directTransport)
    // the relay socket opened -> at least one status emission (connecting/online)
    await new Promise((r) => queueMicrotask(() => r(null)))
    expect(statuses.length).toBeGreaterThan(0)
  })
})
