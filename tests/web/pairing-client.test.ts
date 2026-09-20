// @vitest-environment jsdom
//
// Phone-side pairing client unit tests. The crypto + the daemon pairing engine are the REAL M1/M4
// modules — only "the other end of the wire" is a fixture: an in-test pairing shim that plays the
// daemon (parses the phone's cleartext phase-(i) Hello envelope, feeds it to the real remote-pairing
// engine, relays the PairAck back, and on a confirm signals `confirmed`). The phone here derives its
// own session over the daemon's TRANSMITTED pubkey via deriveDeviceSession — it never copies the
// daemon's keys, so the MITM / no-confirm asserts bite instead of passing vacuously.
//
// Every assert must FAIL if the product is reversed: a tampered PairAck must diverge the SAS AND make
// the phone's sealed frame un-openable by the daemon (P3); a faked `confirmed` with no desktop confirm
// must leave the gateway mint 403 → no usable session, store untouched (P2); the persisted record must
// never carry the pairing secret / derived keys / a UI token (P5).

import { randomUUID } from 'node:crypto'

import { describe, expect, test, vi } from 'vitest'
import { HB_PING, HB_PONG } from '../../src/server/remote-control-constants.js'
import type { RemoteDeviceRecord } from '../../src/server/remote-device-store.js'
import { createRemotePairing, type RemotePairing } from '../../src/server/remote-pairing.js'
import {
  createOpener,
  createSealer,
  type DeviceKeyPair,
  decodePairingPayload,
  deriveDeviceSession,
  type FrameOpener,
  type FrameSealer,
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
  openNext,
  REMOTE_CRYPTO_VERSION,
  sealNext,
} from '../../src/shared/remote-crypto.js'
import { encodeHeader, FrameKind } from '../../src/shared/remote-protocol.js'
import type {
  DeviceSessionStore,
  StoredDeviceSession,
} from '../../web/src/transport/device-session-store.js'
import {
  createPairingClient,
  type PairingClientDeps,
  type PairingClientEvents,
  type PairingPhase,
} from '../../web/src/transport/pairing-client.js'

// ── a real daemon-pairing engine, in-memory device store + audit stub ────────────────────────────

const makeEngine = (): { engine: RemotePairing; inserted: RemoteDeviceRecord[] } => {
  const inserted: RemoteDeviceRecord[] = []
  const deviceStore = {
    insert: (input: {
      id: string
      name: string
      keys: { d2p: Uint8Array; p2d: Uint8Array }
      devicePublicKey: Uint8Array
    }): RemoteDeviceRecord => {
      const rec: RemoteDeviceRecord = {
        id: input.id,
        name: input.name,
        createdAt: 1,
        lastSeenAt: null,
        revoked: false,
      } as unknown as RemoteDeviceRecord
      inserted.push(rec)
      return rec
    },
  }
  const audit = { enqueue: () => {} }
  const engine = createRemotePairing({
    deviceStore: deviceStore as never,
    audit: audit as never,
    getGatewayUrl: () => 'wss://gw.test',
    getDaemonId: () => 'daemon-pair-1',
  })
  return { engine, inserted }
}

// ── the in-memory pairing wire + daemon shim ──────────────────────────────────────────────────────
// The phone client opens a WebSocketLike against this. The shim parses the phone's phase-(i) Hello
// envelope (cleartext public material), drives the REAL engine, and relays the PairAck back. It can be
// told to NOT confirm (P2), to tamper the relayed daemon pubkey (P3), or to drop the socket (P4).

const te = new TextEncoder()

interface ShimOpts {
  engine: RemotePairing
  tamper?: boolean
  autoConfirm?: boolean // default true; false → never sends `confirmed`
  fakeConfirmWithoutEngine?: boolean // P2: send `confirmed` but DON'T call engine.confirmPairing
}

class FakePairingSocket {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  closed = false
  readonly sent: string[] = []
  private onPhoneSend: (data: string) => void = () => {}

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const list = this.listeners[type] ?? []
    list.push(cb)
    this.listeners[type] = list
  }
  private fire(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
  send(data: string | ArrayBufferLike): void {
    if (typeof data !== 'string') {
      // phase (ii) sealed frame — record raw for the shim to open
      this.onPhoneSend(
        JSON.stringify({ __binary: Array.from(new Uint8Array(data as ArrayBuffer)) })
      )
      return
    }
    this.sent.push(data)
    this.onPhoneSend(data)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.fire('close', { code: 1000 })
  }

  // test/shim hooks
  _open(): void {
    this.fire('open', {})
  }
  _deliver(text: string): void {
    this.fire('message', { data: text })
  }
  _deliverBinary(bytes: Uint8Array): void {
    this.fire('message', {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
  }
  _drop(): void {
    if (this.closed) return
    this.closed = true
    this.fire('close', { code: 1006 })
  }
  _onPhoneSend(cb: (data: string) => void): void {
    this.onPhoneSend = cb
  }
}

const flipByte = (b: Uint8Array): Uint8Array => {
  const out = Uint8Array.from(b)
  out[0] = (out[0] ?? 0) ^ 0x01
  return out
}

// Build the shim's phase-(i) handling. Returns the socket + a record of what the engine did so the
// MITM (P3) test can grab the phone's sealed frame and prove the daemon can't open it.
const startShim = (
  socket: FakePairingSocket,
  opts: ShimOpts
): { pairingId: string | null; phoneFramesToDaemon: Uint8Array[] } => {
  const ctx: { pairingId: string | null; phoneFramesToDaemon: Uint8Array[] } = {
    pairingId: null,
    phoneFramesToDaemon: [],
  }
  // The desktop "Add device" already ran: the engine has a pending awaiting_handshake. The QR carries
  // its pairingId implicitly (the secret), but the daemon shim correlates the lone in-flight pending.
  const ticket = (opts as ShimOpts & { __ticket?: { pairingId: string } }).__ticket
  ctx.pairingId = ticket?.pairingId ?? null

  socket._onPhoneSend((data: string) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.__binary) {
      ctx.phoneFramesToDaemon.push(Uint8Array.from(msg.__binary as number[]))
      return
    }
    if (msg.t === 'hello' && ctx.pairingId) {
      const view = opts.engine.submitDeviceHello({
        pairingId: ctx.pairingId,
        devicePublicKey: fromBase64Url(msg.devicePublicKey as string),
        sessionSalt: fromBase64Url(msg.sessionSalt as string),
        ...(msg.proposedName ? { proposedName: msg.proposedName as string } : {}),
      })
      if (!view) return
      const reply = opts.engine.getHandshakeReply(ctx.pairingId)
      if (!reply) return
      const daemonPub = opts.tamper ? flipByte(reply.daemonPublicKey) : reply.daemonPublicKey
      socket._deliver(
        JSON.stringify({
          t: 'pair-ack',
          daemonPublicKey: toB64u(daemonPub),
          daemonId: reply.daemonId,
          deviceId: reply.deviceId,
          protocolVersion: reply.protocolVersion,
        })
      )
      // Desktop confirms (real engine) then the shim signals `confirmed`.
      if (opts.autoConfirm !== false) {
        if (!opts.fakeConfirmWithoutEngine) opts.engine.confirmPairing(ctx.pairingId)
        socket._deliver(JSON.stringify({ t: 'confirmed', deviceId: reply.deviceId }))
      }
    }
  })
  return ctx
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const toB64u = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    const b2 = bytes[i + 2] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
    out += B64_ALPHABET[b2 & 0x3f]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const b0 = bytes[i] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[(b0 & 0x03) << 4]
  } else if (rem === 2) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1] as number
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += B64_ALPHABET[(b1 & 0x0f) << 2]
  }
  return out
}

// ── an in-memory device-session store ──────────────────────────────────────────────────────────────

const makeStore = (): { store: DeviceSessionStore; saved: StoredDeviceSession[] } => {
  const map = new Map<string, StoredDeviceSession>()
  const saved: StoredDeviceSession[] = []
  const key = (gw: string, d: string): string => `${gw}::${d}`
  return {
    saved,
    store: {
      load: (gw, d) => map.get(key(gw, d)) ?? null,
      save: (rec) => {
        map.set(key(rec.gatewayUrl, rec.daemonId), rec)
        saved.push(rec)
      },
      clear: (gw, d) => {
        map.delete(key(gw, d))
      },
    },
  }
}

// Build the QR (the desktop ticket carries it) + wire the shim to the engine's pending.
const setup = (
  shimOpts: Omit<ShimOpts, 'engine'> & { mintSession?: ReturnType<typeof vi.fn> } = {}
): {
  qr: string
  socket: FakePairingSocket
  store: DeviceSessionStore
  saved: StoredDeviceSession[]
  mintSession: ReturnType<typeof vi.fn>
  events: PairingClientEvents
  phases: PairingPhase[]
  sasSeen: string[]
  deps: PairingClientDeps
  shimCtx: { pairingId: string | null; phoneFramesToDaemon: Uint8Array[] }
  inserted: RemoteDeviceRecord[]
} => {
  const { engine, inserted } = makeEngine()
  const ticket = engine.beginPairing()
  const socket = new FakePairingSocket()
  const { store, saved } = makeStore()
  const phases: PairingPhase[] = []
  const sasSeen: string[] = []
  const events: PairingClientEvents = {
    onPhase: (p) => phases.push(p),
    onSas: (s) => sasSeen.push(s),
    onFailure: () => {},
  }
  const mintSession =
    (shimOpts as { mintSession?: ReturnType<typeof vi.fn> }).mintSession ?? vi.fn(async () => {})
  const shimCtx = startShim(socket, {
    engine,
    ...shimOpts,
    __ticket: { pairingId: ticket.pairingId },
  } as ShimOpts & { __ticket: { pairingId: string } })

  const deps: PairingClientDeps = {
    openSocket: () => {
      queueMicrotask(() => socket._open())
      return socket
    },
    store,
    mintSession: mintSession as never,
  }
  return {
    qr: ticket.qr,
    socket,
    store,
    saved,
    mintSession: mintSession as ReturnType<typeof vi.fn>,
    events,
    phases,
    sasSeen,
    deps,
    shimCtx,
    inserted,
  }
}

describe('createPairingClient', () => {
  // P1 — happy path: idle→…→paired; SAS fired once == the daemon pending SAS; store.save called with
  // the keypair (not the secret/derived keys); mintSession called once; result ok.
  test('P1 happy path drives to paired and persists the keypair', async () => {
    const { qr, events, phases, sasSeen, deps, mintSession, saved } = setup()
    const client = createPairingClient(qr, events, deps)
    const result = await client.start()

    expect(result).toEqual({ ok: true, deviceId: expect.any(String) })
    expect(client.phase).toBe('paired')
    expect(phases).toContain('connecting')
    expect(phases).toContain('handshaking')
    expect(phases).toContain('awaiting_confirm')
    expect(phases).toContain('paired')
    // SAS surfaced exactly once, a 6-digit string.
    expect(sasSeen).toHaveLength(1)
    expect(sasSeen[0]).toMatch(/^\d{6}$/)
    // mintSession called once with the right body.
    expect(mintSession).toHaveBeenCalledTimes(1)
    expect(mintSession).toHaveBeenCalledWith('wss://gw.test', {
      daemonId: 'daemon-pair-1',
      deviceId: result.ok ? result.deviceId : '',
    })
    // store.save was called, and the persisted record holds ONLY the keypair + daemon public key.
    expect(saved).toHaveLength(1)
    const rec = saved[0] as StoredDeviceSession
    expect(rec.deviceKeyPair.secretKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(rec.deviceKeyPair.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(rec.daemonPublicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('P1c converts an HTTPS gatewayUrl from the QR into a WSS pairing socket URL', async () => {
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const payload = JSON.parse(ticket.qr) as Record<string, unknown>
    const qr = JSON.stringify({ ...payload, gatewayUrl: 'https://app.hivehq.dev' })
    const { store } = makeStore()
    let openedUrl = ''

    const client = createPairingClient(
      qr,
      { onPhase: () => {}, onSas: () => {}, onFailure: () => {} },
      {
        openSocket: (url) => {
          openedUrl = url
          throw new Error('stop after URL capture')
        },
        store,
        mintSession: async () => {},
      }
    )

    const result = await client.start()
    expect(result.ok).toBe(false)
    expect(openedUrl).toBe(
      `wss://app.hivehq.dev/relay/pair?daemonId=${encodeURIComponent('daemon-pair-1')}`
    )
  })

  // P1b — the phone's derived SAS converges with the daemon's (proving it derived over the relayed
  // pubkey, not copied). The shim records the engine's pending SAS.
  test('P1b phone SAS converges with the daemon SAS', async () => {
    const { engine, inserted } = makeEngine()
    const ticket = engine.beginPairing()
    const socket = new FakePairingSocket()
    const { store } = makeStore()
    const sasSeen: string[] = []
    let daemonSas = ''
    const events: PairingClientEvents = {
      onPhase: () => {},
      onSas: (s) => sasSeen.push(s),
      onFailure: () => {},
    }
    // wrap submitDeviceHello to capture the daemon-side SAS
    const realSubmit = engine.submitDeviceHello.bind(engine)
    engine.submitDeviceHello = (hello) => {
      const view = realSubmit(hello)
      if (view) daemonSas = view.sas
      return view
    }
    startShim(socket, { engine, __ticket: { pairingId: ticket.pairingId } } as never)
    const client = createPairingClient(ticket.qr, events, {
      openSocket: () => {
        queueMicrotask(() => socket._open())
        return socket
      },
      store,
      mintSession: async () => {},
    })
    const result = await client.start()
    expect(result.ok).toBe(true)
    expect(sasSeen[0]).toBe(daemonSas)
    expect(inserted).toHaveLength(1)
  })

  // P2 (adversarial: invariant 2) — a faked `confirmed` with NO desktop confirm: the gateway mint 403s.
  // Result is mint_forbidden; store.save NOT called (the phone can't self-promote).
  test('P2 no desktop confirm → mint 403 → mint_forbidden, store untouched', async () => {
    const mint = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    })
    const { qr, events, deps, saved } = setup({
      fakeConfirmWithoutEngine: true,
      mintSession: mint,
    } as never)
    const client = createPairingClient(qr, events, deps)
    const result = await client.start()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('mint_forbidden')
    expect(saved).toHaveLength(0)
    expect(client.phase).toBe('error')
  })

  // P3 (adversarial: invariant 4) — a MITM-tampered PairAck. Two un-fakeable consequences:
  //   (a) the SAS the client surfaces (derived over the TAMPERED daemon pubkey) ≠ the daemon's SAS —
  //       the human refuses.
  //   (b) a data frame the phone seals with its tampered-derived p2d CANNOT be opened by the daemon's
  //       real p2d opener — proving the phone derived its own keys over the relayed pubkey rather than
  //       copying the daemon's session. This is the assertion that bites if the client ever trusted a
  //       relayed key blindly.
  test('P3 MITM-tampered PairAck diverges SAS and the sealed frame is un-openable by the daemon', async () => {
    // Own the phone keypair + salt + pairing secret so we can reconstruct BOTH halves of the handshake.
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const pairingSecret = fromBase64Url(decodePairingPayload(ticket.qr).pairingSecret)
    const phoneKp: DeviceKeyPair = generateDeviceKeyPair()
    const phoneSalt = generateSessionSalt()

    const socket = new FakePairingSocket()
    const { store } = makeStore()
    const sasSeen: string[] = []
    let daemonSas = ''
    let trueDaemonPub: Uint8Array | null = null
    let ids = { daemonId: '', deviceId: '', protocolVersion: REMOTE_CRYPTO_VERSION }
    const realSubmit = engine.submitDeviceHello.bind(engine)
    engine.submitDeviceHello = (hello) => {
      const view = realSubmit(hello)
      if (view) daemonSas = view.sas
      return view
    }
    // shim with tamper on the relayed daemon pubkey; capture the TRUE pubkey for our daemon-side derive.
    socket._onPhoneSend((data: string) => {
      const msg = JSON.parse(data) as Record<string, unknown>
      if (msg.t !== 'hello') return
      engine.submitDeviceHello({
        pairingId: ticket.pairingId,
        devicePublicKey: fromBase64Url(msg.devicePublicKey as string),
        sessionSalt: fromBase64Url(msg.sessionSalt as string),
      })
      const reply = engine.getHandshakeReply(ticket.pairingId)
      if (!reply) return
      trueDaemonPub = reply.daemonPublicKey
      ids = {
        daemonId: reply.daemonId,
        deviceId: reply.deviceId,
        protocolVersion: reply.protocolVersion,
      }
      socket._deliver(
        JSON.stringify({
          t: 'pair-ack',
          daemonPublicKey: toB64u(flipByte(reply.daemonPublicKey)), // MITM swap
          daemonId: reply.daemonId,
          deviceId: reply.deviceId,
          protocolVersion: reply.protocolVersion,
        })
      )
      socket._deliver(JSON.stringify({ t: 'confirmed', deviceId: reply.deviceId }))
    })

    const client = createPairingClient(
      ticket.qr,
      { onPhase: () => {}, onSas: (s) => sasSeen.push(s), onFailure: () => {} },
      {
        openSocket: () => {
          queueMicrotask(() => socket._open())
          return socket
        },
        store,
        mintSession: async () => {},
        // Hand the client a COPY so the test keeps untouched bytes — the client wipes its own copy on
        // success, but our reconstruction needs the original secret key + salt.
        generateKeyPair: () => ({
          secretKey: Uint8Array.from(phoneKp.secretKey),
          publicKey: Uint8Array.from(phoneKp.publicKey),
        }),
        generateSalt: () => Uint8Array.from(phoneSalt),
      }
    )
    const result = await client.start()
    expect(result.ok).toBe(true) // the client can't see the tamper; only the human (SAS) can
    if (!trueDaemonPub) throw new Error('shim never captured the daemon pubkey')

    // (a) the client surfaced exactly one SAS, derived over the TAMPERED pubkey — it diverges.
    expect(sasSeen).toHaveLength(1)
    expect(sasSeen[0]).not.toBe(daemonSas)

    // Reconstruct the daemon's REAL session (true device pubkey, true salt, true daemon pubkey) and the
    // phone's TAMPERED session (the exact key material the client used). The two are different keys.
    const phoneTampered = deriveDeviceSession({
      deviceSecretKey: phoneKp.secretKey,
      daemonPublicKey: flipByte(trueDaemonPub),
      devicePublicKey: phoneKp.publicKey,
      pairingSecret,
      sessionSalt: phoneSalt,
      ids,
    })
    expect(phoneTampered.sas).toBe(sasSeen[0]) // the client's SAS came from THIS derivation

    // The daemon's real p2d opener (the bytes the engine actually holds for this device) must REJECT a
    // frame the phone sealed with its tampered p2d. We reconstruct the daemon's real keys by deriving
    // the device session over the TRUE pubkey (== the daemon's d2p/p2d by the symmetry of the schedule).
    const daemonReal = deriveDeviceSession({
      deviceSecretKey: phoneKp.secretKey,
      daemonPublicKey: trueDaemonPub,
      devicePublicKey: phoneKp.publicKey,
      pairingSecret,
      sessionSalt: phoneSalt,
      ids,
    })
    expect(toB64u(phoneTampered.p2d)).not.toBe(toB64u(daemonReal.p2d))

    // Seal a frame with the phone's tampered p2d, try to open it with the daemon's real p2d → throws.
    const sealer: FrameSealer = createSealer('p2d')
    const streamId = 1
    const headerBytes = encodeHeader({
      version: REMOTE_CRYPTO_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId,
      seq: 0,
    })
    const { ciphertext } = sealNext(sealer, {
      key: phoneTampered.p2d,
      streamId,
      headerBytes,
      payload: te.encode('hello daemon'),
    })
    const opener: FrameOpener = createOpener('p2d')
    expect(() =>
      openNext(opener, { key: daemonReal.p2d, streamId, headerBytes, ciphertext, seq: 0 })
    ).toThrow()
  })

  // P4 — protocolVersion mismatch in the PairAck → fail('protocol_version'); socket drop pre-paired →
  // fail('socket_closed').
  test('P4a protocolVersion mismatch fails the pairing', async () => {
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const socket = new FakePairingSocket()
    const { store } = makeStore()
    // shim that returns a bad protocolVersion
    socket._onPhoneSend((data: string) => {
      const msg = JSON.parse(data) as Record<string, unknown>
      if (msg.t === 'hello') {
        const view = engine.submitDeviceHello({
          pairingId: ticket.pairingId,
          devicePublicKey: fromBase64Url(msg.devicePublicKey as string),
          sessionSalt: fromBase64Url(msg.sessionSalt as string),
        })
        if (!view) return
        const reply = engine.getHandshakeReply(ticket.pairingId)
        if (!reply) return
        socket._deliver(
          JSON.stringify({
            t: 'pair-ack',
            daemonPublicKey: toB64u(reply.daemonPublicKey),
            daemonId: reply.daemonId,
            deviceId: reply.deviceId,
            protocolVersion: REMOTE_CRYPTO_VERSION + 99,
          })
        )
      }
    })
    const failures: string[] = []
    const client = createPairingClient(
      ticket.qr,
      { onPhase: () => {}, onSas: () => {}, onFailure: (f) => failures.push(f.code) },
      {
        openSocket: () => {
          queueMicrotask(() => socket._open())
          return socket
        },
        store,
        mintSession: async () => {},
      }
    )
    const result = await client.start()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('protocol_version')
    expect(failures).toContain('protocol_version')
  })

  test('P4b socket drop before paired fails with socket_closed', async () => {
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const socket = new FakePairingSocket()
    const { store } = makeStore()
    const client = createPairingClient(
      ticket.qr,
      { onPhase: () => {}, onSas: () => {}, onFailure: () => {} },
      {
        openSocket: () => {
          queueMicrotask(() => {
            socket._open()
            // drop right after open, before any PairAck
            queueMicrotask(() => socket._drop())
          })
          return socket
        },
        store,
        mintSession: async () => {},
      }
    )
    const result = await client.start()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('socket_closed')
  })

  test('P4c pairing heartbeat keeps the awaiting-confirm socket alive when ponged', async () => {
    vi.useFakeTimers()
    try {
      const { qr, events, deps, socket } = setup({ autoConfirm: false })
      const client = createPairingClient(qr, events, {
        ...deps,
        heartbeatMs: 20,
        heartbeatDeadlineMs: 10,
      })
      let settled = false
      const resultPromise = client.start().then((result) => {
        settled = true
        return result
      })

      await Promise.resolve()
      await Promise.resolve()
      expect(client.phase).toBe('awaiting_confirm')

      vi.advanceTimersByTime(20)
      expect(socket.sent).toContain(HB_PING)
      socket._deliver(HB_PONG)
      vi.advanceTimersByTime(10)

      expect(settled).toBe(false)
      expect(socket.closed).toBe(false)
      expect(client.phase).toBe('awaiting_confirm')

      client.cancel()
      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.failure.code).toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })

  test('P4d a heartbeat timeout past the SAS consults the mint (recovers), not a blind socket_closed', async () => {
    vi.useFakeTimers()
    try {
      const { qr, events, deps, socket, mintSession } = setup({ autoConfirm: false })
      const client = createPairingClient(qr, events, {
        ...deps,
        heartbeatMs: 20,
        heartbeatDeadlineMs: 10,
      })
      const resultPromise = client.start()

      await Promise.resolve()
      await Promise.resolve()
      expect(client.phase).toBe('awaiting_confirm')

      vi.advanceTimersByTime(20) // ping sent, no pong
      expect(socket.sent).toContain(HB_PING)
      vi.advanceTimersByTime(10) // pong deadline → half-open socket → consult /pair/session, not a blind fail

      // The desktop had confirmed (the mint resolves), so a dead socket still recovers to paired — the
      // old behavior failed socket_closed here. (await the result; the mint is promise-driven, no timers.)
      const result = await resultPromise
      expect(mintSession).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ ok: true, deviceId: expect.any(String) })
      expect(socket.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('P4f a socket close past the SAS mints once — recovers a `confirmed` frame lost on a flaky link', async () => {
    const { qr, events, deps, socket, mintSession, saved } = setup({ autoConfirm: false })
    const client = createPairingClient(qr, events, deps)
    const resultPromise = client.start()

    await Promise.resolve()
    await Promise.resolve()
    expect(client.phase).toBe('awaiting_confirm')
    expect(mintSession).not.toHaveBeenCalled() // SAS is up; nothing minted yet

    socket._drop() // the link dropped before `confirmed` arrived

    const result = await resultPromise
    expect(mintSession).toHaveBeenCalledTimes(1) // the drop consulted the /pair/session authority
    expect(result).toEqual({ ok: true, deviceId: expect.any(String) })
    expect(client.phase).toBe('paired')
    expect(saved).toHaveLength(1) // durable session persisted on the recovery
  })

  test('P4g a dropped socket the gateway has NOT confirmed fails mint_forbidden — not socket_closed', async () => {
    const mint = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    })
    const { qr, events, deps, socket } = setup({ autoConfirm: false, mintSession: mint })
    const failures: string[] = []
    events.onFailure = (failure) => failures.push(failure.code)
    const client = createPairingClient(qr, events, deps)
    const resultPromise = client.start()

    await Promise.resolve()
    await Promise.resolve()
    expect(client.phase).toBe('awaiting_confirm')

    socket._drop()

    const result = await resultPromise
    expect(mint).toHaveBeenCalledTimes(1)
    // Tried the authority and got a definite "no" — mint_forbidden, NOT a vague socket_closed.
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('mint_forbidden')
    expect(failures).toEqual(['mint_forbidden'])
  })

  test('P4e daemon rejected expired maps to an expired failure instead of socket_closed', async () => {
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const socket = new FakePairingSocket()
    const { store } = makeStore()
    const failures: string[] = []
    socket._onPhoneSend(() => {
      socket._deliver(JSON.stringify({ t: 'rejected', reason: 'expired' }))
    })
    const client = createPairingClient(
      ticket.qr,
      { onPhase: () => {}, onSas: () => {}, onFailure: (failure) => failures.push(failure.code) },
      {
        openSocket: () => {
          queueMicrotask(() => socket._open())
          return socket
        },
        store,
        mintSession: async () => {},
      }
    )

    const result = await client.start()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.code).toBe('expired')
    expect(failures).toEqual(['expired'])
    expect(client.phase).toBe('expired')
  })

  // P5 / C2 (invariant 3, M6.1) — the persisted StoredDeviceSession is v:2 and carries the directional
  // ROOT (rootKeys) so a reload can rebuild the session, but still NO pairingSecret, NO sessionSalt, NO
  // ephemeral connKey, NO hive_ui_token. The phone MUST persist the root (it can't re-derive on reload);
  // it must NOT over-persist the pairing secret or the per-connection AEAD key.
  test('P5 persisted record is v2 with rootKeys but no secret/ephemeral/ui-token material', async () => {
    const { qr, events, deps, saved } = setup()
    const client = createPairingClient(qr, events, deps)
    await client.start()
    expect(saved).toHaveLength(1)
    const rec = saved[0] as StoredDeviceSession
    expect(rec.v).toBe(2)

    const serialized = JSON.stringify(rec)
    expect(serialized).not.toContain('pairingSecret')
    expect(serialized).not.toContain('sessionSalt')
    expect(serialized).not.toContain('connKey')
    expect(serialized).not.toContain('hive_ui_token')
    expect(serialized).not.toContain('transcriptHash')

    // The root IS persisted, base64url, distinct per direction (not truncated / not [object Object]).
    expect(rec.rootKeys).toBeDefined()
    expect(rec.rootKeys.d2p).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(rec.rootKeys.p2d).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(rec.rootKeys.d2p).not.toBe(rec.rootKeys.p2d)
    // 32-byte key -> 43 base64url chars (no padding).
    expect(fromBase64Url(rec.rootKeys.d2p)).toHaveLength(32)
    expect(fromBase64Url(rec.rootKeys.p2d)).toHaveLength(32)

    // shape: durable identity + the root, nothing else.
    expect(Object.keys(rec).sort()).toEqual(
      [
        'daemonId',
        'daemonPublicKey',
        'deviceId',
        'deviceKeyPair',
        'gatewayUrl',
        'pairedAt',
        'protocolVersion',
        'rootKeys',
        'v',
      ].sort()
    )
    void randomUUID
  })

  // C2b — the persisted root is the LIVE derived root, byte-for-byte. We re-derive the phone's session
  // (own the keypair + salt) and assert the saved rootKeys equal the derived d2p/p2d. A fix that
  // persisted the wrong field, a constant, or zeroed bytes (e.g. saving AFTER wipe()) trips here.
  test('C2b persisted rootKeys are byte-equal to the live derived directional keys', async () => {
    const { engine } = makeEngine()
    const ticket = engine.beginPairing()
    const pairingSecret = fromBase64Url(decodePairingPayload(ticket.qr).pairingSecret)
    const phoneKp: DeviceKeyPair = generateDeviceKeyPair()
    const phoneSalt = generateSessionSalt()

    const socket = new FakePairingSocket()
    const { store, saved } = makeStore()
    let trueDaemonPub: Uint8Array | null = null
    let ids = { daemonId: '', deviceId: '', protocolVersion: REMOTE_CRYPTO_VERSION }
    socket._onPhoneSend((data: string) => {
      const msg = JSON.parse(data) as Record<string, unknown>
      if (msg.t !== 'hello') return
      engine.submitDeviceHello({
        pairingId: ticket.pairingId,
        devicePublicKey: fromBase64Url(msg.devicePublicKey as string),
        sessionSalt: fromBase64Url(msg.sessionSalt as string),
      })
      const reply = engine.getHandshakeReply(ticket.pairingId)
      if (!reply) return
      trueDaemonPub = reply.daemonPublicKey
      ids = {
        daemonId: reply.daemonId,
        deviceId: reply.deviceId,
        protocolVersion: reply.protocolVersion,
      }
      engine.confirmPairing(ticket.pairingId)
      socket._deliver(
        JSON.stringify({
          t: 'pair-ack',
          daemonPublicKey: toB64u(reply.daemonPublicKey),
          daemonId: reply.daemonId,
          deviceId: reply.deviceId,
          protocolVersion: reply.protocolVersion,
        })
      )
      socket._deliver(JSON.stringify({ t: 'confirmed', deviceId: reply.deviceId }))
    })

    const client = createPairingClient(
      ticket.qr,
      { onPhase: () => {}, onSas: () => {}, onFailure: () => {} },
      {
        openSocket: () => {
          queueMicrotask(() => socket._open())
          return socket
        },
        store,
        mintSession: async () => {},
        generateKeyPair: () => ({
          secretKey: Uint8Array.from(phoneKp.secretKey),
          publicKey: Uint8Array.from(phoneKp.publicKey),
        }),
        generateSalt: () => Uint8Array.from(phoneSalt),
      }
    )
    const result = await client.start()
    expect(result.ok).toBe(true)
    if (!trueDaemonPub) throw new Error('shim never captured the daemon pubkey')

    const live = deriveDeviceSession({
      deviceSecretKey: phoneKp.secretKey,
      daemonPublicKey: trueDaemonPub,
      devicePublicKey: phoneKp.publicKey,
      pairingSecret,
      sessionSalt: phoneSalt,
      ids,
    })
    const rec = saved[0] as StoredDeviceSession
    expect(fromBase64Url(rec.rootKeys.d2p)).toEqual(live.d2p)
    expect(fromBase64Url(rec.rootKeys.p2d)).toEqual(live.p2d)
  })
})
