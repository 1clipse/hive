import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteAuditStore,
  type RemoteAuditStore,
} from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { GW_CONTROL_PREFIX, HB_PONG } from '../../src/server/remote-control-constants.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import type { RemotePairing } from '../../src/server/remote-pairing.js'
import type {
  PairingOutboundFrame,
  RemotePairingTunnel,
  RemotePairingTunnelDeps,
} from '../../src/server/remote-pairing-tunnel.js'
import {
  createRemoteTunnel,
  type FrameBridge,
  type RemoteTunnel,
} from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'

// Tunnel-level wiring tests for the pairing-over-tunnel band (plan step 2). We assert ONLY the
// add-only routing the spec demands:
//   - a TEXT pairing frame is handed to the pairing driver (driver.onPairingFrame)
//   - a BINARY frame STILL goes to bridge.onInbound (the data tunnel must stay byte-identical)
//   - HB_PONG and GW_CONTROL frames are still handled (and NOT misrouted to the pairing driver)
//   - a peer-online role:'pair' with a jti calls driver.onPeerOnline(jti)
// No node-pty / no PTY anywhere; the socket is a tiny controllable fake so we fire frames directly.

// A minimal controllable WebSocket the test drives by hand (same shape the lifecycle test uses).
class FakeSocket {
  static instances: FakeSocket[] = []
  binaryType = 'arraybuffer'
  sent: Array<string | Uint8Array> = []
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  constructor(
    public url: string,
    public protocols: string[]
  ) {
    FakeSocket.instances.push(this)
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
    return this
  }
  once(event: string, cb: (...a: unknown[]) => void): this {
    return this.on(event, cb)
  }
  removeAllListeners(): this {
    this.handlers.clear()
    return this
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.fire('close', 1000, Buffer.from('closed'))
  }
  terminate(): void {
    this.fire('close', 1006, Buffer.from('terminated'))
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args)
  }
}

const noopTimers = () => ({
  setTimer: (_fn: () => void, _ms: number) => 0 as unknown as NodeJS.Timeout,
  clearTimer: (_h: NodeJS.Timeout) => {},
  now: () => 0,
})

describe('remote tunnel — pairing-over-tunnel routing (add-only)', () => {
  let db: InstanceType<typeof Database>
  let audit: RemoteAuditStore
  let provider: InMemoryDeviceSessionProvider
  let tunnel: RemoteTunnel | undefined

  // Spies for the driver + bridge so we observe exactly where each frame goes.
  let pairingFrames: string[]
  let peerOnlineJtis: Array<string | undefined>
  let confirmCalls: Array<{ pairingId: string; name?: string }>
  let bridgeInbound: Uint8Array[]
  let bridgeResets: string[]
  let driverSend: ((f: PairingOutboundFrame) => void) | null

  const fakeDriver: RemotePairingTunnel = {
    onPeerOnline: (jti) => peerOnlineJtis.push(jti),
    onPairingFrame: (text) => pairingFrames.push(text),
    confirm: async (pairingId, name) => {
      confirmCalls.push(name === undefined ? { pairingId } : { pairingId, name })
      return null
    },
  }

  const fakeBridge: FrameBridge = {
    attachSocket: () => {},
    onInbound: (frame) => bridgeInbound.push(new Uint8Array(frame)),
    resetAllStreams: (reason) => bridgeResets.push(reason),
    closeDevice: () => {},
  }

  const config: RemoteConfigSource = {
    isEnabled: () => true,
    getGatewayUrl: () => 'wss://gw.example/',
    getDaemonToken: () => 'tok',
    getDaemonId: () => 'd1',
  }

  // A pairing engine is REQUIRED for the tunnel to build a driver; the engine itself is unused because
  // createPairingTunnel is stubbed to fakeDriver. A cast-only stub is fine (the seam swallows it).
  const fakeEngine = {} as RemotePairing

  beforeEach(() => {
    db = new Database(':memory:')
    applySchemaVersion23(db)
    audit = createRemoteAuditStore(db)
    provider = new InMemoryDeviceSessionProvider()
    FakeSocket.instances.length = 0
    pairingFrames = []
    peerOnlineJtis = []
    confirmCalls = []
    bridgeInbound = []
    bridgeResets = []
    driverSend = null
  })

  afterEach(async () => {
    if (tunnel) await tunnel.close()
    tunnel = undefined
    if (db.isOpen) db.close()
  })

  const build = (): { tunnel: RemoteTunnel; socket: FakeSocket } => {
    const timers = noopTimers()
    tunnel = createRemoteTunnel({
      loopbackPort: 1,
      config,
      deviceSessions: provider,
      loopbackSecret: 'secret',
      audit,
      onStatus: () => {},
      pairing: fakeEngine,
      WebSocketImpl: FakeSocket as unknown as typeof import('ws').WebSocket,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
      createBridge: () => fakeBridge,
      createPairingTunnel: (deps: RemotePairingTunnelDeps) => {
        // Capture the tunnel-provided send so we can prove it targets the live socket.
        driverSend = deps.send
        return fakeDriver
      },
    })
    tunnel.refresh()
    const socket = FakeSocket.instances[0]
    if (!socket) throw new Error('no socket constructed')
    socket.fire('open')
    return { tunnel, socket }
  }

  it('routes a TEXT pairing frame to the driver (not the bridge, not control)', () => {
    const { socket } = build()
    const hello = JSON.stringify({ t: 'hello', devicePublicKey: 'aaaa', sessionSalt: 'bbbb' })
    socket.fire('message', Buffer.from(hello), false)

    expect(pairingFrames).toEqual([hello])
    expect(bridgeInbound).toHaveLength(0) // a text frame is NOT a data-tunnel frame
  })

  it('still delivers a BINARY frame to bridge.onInbound (data tunnel byte-identical)', () => {
    const { socket } = build()
    socket.fire('message', Buffer.from([1, 2, 3, 4]), true)

    expect(bridgeInbound).toHaveLength(1)
    expect([...(bridgeInbound[0] ?? [])]).toEqual([1, 2, 3, 4])
    // A binary frame must NEVER reach the pairing driver.
    expect(pairingFrames).toHaveLength(0)
  })

  it('still handles HB_PONG and does not misroute it to the pairing driver', () => {
    const { socket } = build()
    socket.fire('message', Buffer.from(HB_PONG), false)
    // HB_PONG clears the heartbeat deadline; it must not be treated as a pairing frame or a data frame.
    expect(pairingFrames).toHaveLength(0)
    expect(bridgeInbound).toHaveLength(0)
  })

  it('still handles GW_CONTROL frames and does not misroute them to the pairing driver', () => {
    const { socket } = build()
    const control = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-offline', role: 'device' })}`
    socket.fire('message', Buffer.from(control), false)
    expect(pairingFrames).toHaveLength(0)
    expect(bridgeInbound).toHaveLength(0)
  })

  it('captures the jti from a peer-online role:pair control frame', () => {
    const { socket } = build()
    const control = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-online', role: 'pair', jti: 'jti-789' })}`
    socket.fire('message', Buffer.from(control), false)
    expect(peerOnlineJtis).toEqual(['jti-789'])
  })

  it('a peer-offline role:pair must NOT reset data-tunnel streams (control-plane only)', () => {
    // Pairing-socket churn (the unpaired phone closing /relay/pair — normal at the end of every
    // pairing) emits peer-offline role:'pair'. It must NOT touch the DATA tunnel, or an already-paired
    // phone's in-flight streams would be reset whenever someone pairs. (relay-do invariant: ignore
    // role:'pair' for stream-reset.) A device/daemon peer-offline DOES reset (that data phone left).
    const { socket } = build()
    const pairOff = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-offline', role: 'pair' })}`
    socket.fire('message', Buffer.from(pairOff), false)
    expect(bridgeResets).toHaveLength(0) // pair peer-offline left the data plane alone

    const deviceOff = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-offline', role: 'device' })}`
    socket.fire('message', Buffer.from(deviceOff), false)
    expect(bridgeResets).toHaveLength(1) // a device peer-offline DOES reset the in-flight streams
  })

  it('does NOT call onPeerOnline for a non-pair peer-online (daemon/device)', () => {
    const { socket } = build()
    const daemon = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-online', role: 'daemon' })}`
    const device = `${GW_CONTROL_PREFIX}${JSON.stringify({ t: 'peer-online', role: 'device' })}`
    socket.fire('message', Buffer.from(daemon), false)
    socket.fire('message', Buffer.from(device), false)
    expect(peerOnlineJtis).toHaveLength(0)
  })

  it('the driver send() targets the live socket (JSON text frame)', () => {
    const { socket } = build()
    expect(driverSend).not.toBeNull()
    const frame: PairingOutboundFrame = { t: 'confirmed', deviceId: 'dev-1' }
    driverSend?.(frame)
    // The most recent thing written to the socket is the JSON-encoded frame (a string, not binary).
    const last = socket.sent.at(-1)
    expect(typeof last).toBe('string')
    expect(JSON.parse(last as string)).toEqual(frame)
  })

  it('confirmPairing delegates to the driver', async () => {
    const { tunnel: t } = build()
    await t.confirmPairing('pairing-9', 'My Phone')
    expect(confirmCalls).toEqual([{ pairingId: 'pairing-9', name: 'My Phone' }])
  })

  it('a tunnel built WITHOUT a pairing engine ignores text pairing frames (no driver)', () => {
    const timers = noopTimers()
    tunnel = createRemoteTunnel({
      loopbackPort: 1,
      config,
      deviceSessions: provider,
      loopbackSecret: 'secret',
      audit,
      onStatus: () => {},
      // no `pairing` -> no driver
      WebSocketImpl: FakeSocket as unknown as typeof import('ws').WebSocket,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
      createBridge: () => fakeBridge,
    })
    tunnel.refresh()
    const socket = FakeSocket.instances[0]
    socket?.fire('open')
    socket?.fire('message', Buffer.from(JSON.stringify({ t: 'hello' })), false)
    // No driver: the pairing frame is ignored, the bridge is untouched, nothing throws.
    expect(pairingFrames).toHaveLength(0)
    expect(bridgeInbound).toHaveLength(0)
  })
})
