import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRemoteAuditStore,
  type RemoteAuditStore,
} from '../../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../../src/server/remote-config-keys.js'
import { InMemoryDeviceSessionProvider } from '../../src/server/remote-device-session.js'
import {
  createRemoteTunnel,
  type RemoteTunnel,
  type TunnelStatus,
  type TunnelStatusEvent,
} from '../../src/server/remote-tunnel.js'
import Database from '../../src/server/sqlite.js'
import { applySchemaVersion23 } from '../../src/server/sqlite-schema-v23.js'
import { type FakeGateway, startFakeGateway } from '../helpers/fake-gateway.js'

// These are LIFECYCLE tests for the outbound socket controller: connect, auth-reject, heartbeat,
// reconnect with backoff, revoke, clean shutdown, generation guard. They run against a REAL `ws`
// server (the fake gateway) — no mocked socket, no mocked PTY. The bridge demux (E2E open/seal +
// loopback) is a separate stage; here the tunnel uses a no-op/observing bridge so the socket FSM is
// tested in isolation.

const TOKEN = 'daemon-token-abc'

const mutableConfig = (init: {
  enabled: boolean
  gatewayUrl: string | null
  token: string | null
  daemonId: string | null
}): RemoteConfigSource & {
  setEnabled: (v: boolean) => void
  setGatewayUrl: (v: string | null) => void
  setToken: (v: string | null) => void
} => {
  let { enabled, gatewayUrl, token } = init
  const { daemonId } = init
  return {
    isEnabled: () => enabled,
    getGatewayUrl: () => gatewayUrl,
    getDaemonToken: () => token,
    getDaemonId: () => daemonId,
    setEnabled: (v) => {
      enabled = v
    },
    setGatewayUrl: (v) => {
      gatewayUrl = v
    },
    setToken: (v) => {
      token = v
    },
  }
}

// Deterministic, manually-pumped timer seam. The tunnel schedules reconnect/heartbeat through this;
// tests advance time explicitly so backoff is observable without wall-clock waits.
const manualTimers = () => {
  let seq = 0
  const timers = new Map<number, { fire: () => void; due: number }>()
  let clock = 0
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { fire: fn, due: clock + ms })
      return id as unknown as NodeJS.Timeout
    },
    clearTimer: (h: NodeJS.Timeout) => {
      timers.delete(h as unknown as number)
    },
    advance: (ms: number) => {
      clock += ms
      // Fire everything now due, in insertion order, popping as we go.
      const ready = [...timers.entries()].filter(([, t]) => t.due <= clock)
      for (const [id, t] of ready) {
        timers.delete(id)
        t.fire()
      }
    },
    pending: () => timers.size,
  }
}

describe('remote tunnel — outbound socket lifecycle', () => {
  let gateway: FakeGateway
  let db: InstanceType<typeof Database>
  let audit: RemoteAuditStore
  let provider: InMemoryDeviceSessionProvider
  let tunnel: RemoteTunnel | undefined
  const events: TunnelStatusEvent[] = []

  beforeEach(async () => {
    gateway = await startFakeGateway({ expectedToken: TOKEN })
    db = new Database(':memory:')
    applySchemaVersion23(db)
    audit = createRemoteAuditStore(db)
    provider = new InMemoryDeviceSessionProvider()
    events.length = 0
  })

  afterEach(async () => {
    if (tunnel) await tunnel.close()
    tunnel = undefined
    await gateway.close()
    db.close()
  })

  const build = (
    cfg: ReturnType<typeof mutableConfig>,
    overrides: Partial<Parameters<typeof createRemoteTunnel>[0]> = {}
  ): RemoteTunnel => {
    tunnel = createRemoteTunnel({
      loopbackPort: 1,
      config: cfg,
      deviceSessions: provider,
      loopbackSecret: 'per-boot-secret',
      audit,
      onStatus: (e) => events.push(e),
      ...overrides,
    })
    return tunnel
  }

  const waitFor = async (
    pred: () => boolean,
    timeoutMs = 2000,
    label = 'condition'
  ): Promise<void> => {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  const lastStatus = (): TunnelStatus | undefined => events.at(-1)?.status

  const makeConnectingAbortSocket = () => {
    class ConnectingSocket {
      static instances: ConnectingSocket[] = []
      binaryType = 'arraybuffer'
      private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

      constructor(
        public url: string,
        public protocols: string[]
      ) {
        ConnectingSocket.instances.push(this)
      }

      on(event: string, cb: (...args: unknown[]) => void): this {
        const list = this.handlers.get(event) ?? []
        list.push(cb)
        this.handlers.set(event, list)
        return this
      }

      once(event: string, cb: (...args: unknown[]) => void): this {
        return this.on(event, cb)
      }

      removeAllListeners(): this {
        this.handlers.clear()
        return this
      }

      send(): void {}

      close(): void {
        queueMicrotask(() => {
          this.fire(
            'error',
            new Error('WebSocket was closed before the connection was established')
          )
          this.fire('close', 1006, Buffer.from('shutdown'))
        })
      }

      terminate(): void {
        this.close()
      }

      fire(event: string, ...args: unknown[]): void {
        const callbacks = this.handlers.get(event) ?? []
        if (event === 'error' && callbacks.length === 0) {
          throw args[0] instanceof Error ? args[0] : new Error(String(args[0]))
        }
        for (const cb of callbacks) cb(...args)
      }
    }

    return ConnectingSocket
  }

  it('connects to /relay/daemon presenting bearer.<token> and reaches online', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg)
    t.refresh()

    await gateway.waitForDaemon()
    await waitFor(() => t.status() === 'online', 2000, 'online')

    expect(gateway.connectionCount()).toBe(1)
    // The daemon MUST present bearer.<token> in the subprotocol (M2 contract).
    expect(gateway.lastDaemonProtocol()).toContain(`bearer.${TOKEN}`)
    expect(lastStatus()).toBe('online')
    // session_open audit row recorded on going online.
    await audit.flush()
    expect(audit.list().some((r) => r.action === 'session_open' && r.result === 'ok')).toBe(true)
  })

  it('a wrong bearer token never reaches online — it enters reconnect/backoff (real 401 path)', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: 'WRONG-TOKEN',
      daemonId: 'd1',
    })
    const timers = manualTimers()
    // Deterministic backoff so the armed-retry delay is meaningful (full jitter could legitimately
    // pick 0, which would make a `> 0` assertion flaky without proving anything).
    const t = build(cfg, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
      backoff: { next: () => 500, reset: () => {} },
    })
    t.refresh()

    // The fake gateway rejects the upgrade (token mismatch) → the socket errors/closes, never opens.
    await waitFor(() => events.some((e) => e.status === 'reconnecting'), 2000, 'reconnecting')
    expect(t.status()).not.toBe('online')
    expect(events.some((e) => e.status === 'online')).toBe(false)
    // It armed a retry rather than latching/giving up: EXACTLY ONE reconnect timer is pending (the
    // ws 'unexpected-response' + 'error' double-fire must not schedule two retries — the generation
    // bump in onSocketDown drops the second), and the reported next-retry delay is the backoff value.
    expect(timers.pending()).toBe(1)
    expect(events.find((e) => e.status === 'reconnecting')?.nextRetryInMs).toBe(500)
    expect(events.filter((e) => e.status === 'reconnecting').length).toBe(1)
  })

  it('does NOT connect when disabled — zero outbound sockets, zero timers (invariant 4)', async () => {
    const cfg = mutableConfig({
      enabled: false,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const timers = manualTimers()
    const t = build(cfg, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
    })
    t.refresh()

    // Give it a real window to (incorrectly) connect.
    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(0)
    expect(timers.pending()).toBe(0)
    expect(t.status()).toBe('disabled')
  })

  it('reports loggedOut when enabled but no token, without opening a socket', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: null,
      daemonId: 'd1',
    })
    const t = build(cfg)
    t.refresh()
    await new Promise((r) => setTimeout(r, 100))
    expect(gateway.connectionCount()).toBe(0)
    expect(t.status()).toBe('loggedOut')
  })

  it('reconnects after a transient drop and recovers online', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    // Tiny real backoff so the wall-clock test stays fast but the retry is genuinely scheduled.
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'first online')
    expect(gateway.connectionCount()).toBe(1)

    gateway.dropDaemon()
    await waitFor(() => events.some((e) => e.status === 'reconnecting'), 2000, 'reconnecting')
    await waitFor(() => gateway.connectionCount() >= 2, 3000, 'second connection')
    await waitFor(() => t.status() === 'online', 2000, 'recovered online')
    expect(t.status()).toBe('online')
  })

  it('sends hb:ping heartbeats and stays online while the gateway pongs', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { heartbeatIntervalMs: 30, heartbeatDeadlineMs: 200 })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')
    await gateway.waitForPings(2)
    expect(gateway.pingCount()).toBeGreaterThanOrEqual(2)
    expect(t.status()).toBe('online')
  })

  it('treats a missing pong as a dead socket and reconnects (heartbeat deadline)', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    // Gateway never pongs → the deadline must fire and tear the socket down.
    await gateway.close()
    gateway = await startFakeGateway({ expectedToken: TOKEN, autoPong: false })
    cfg.setGatewayUrl(gateway.url)

    const t = build(cfg, {
      heartbeatIntervalMs: 30,
      heartbeatDeadlineMs: 60,
      backoff: { next: () => 20, reset: () => {} },
    })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')
    await waitFor(() => events.some((e) => e.status === 'reconnecting'), 2000, 'deadline reconnect')
    expect(events.some((e) => e.status === 'reconnecting')).toBe(true)
  })

  it('terminates the stale daemon socket when the heartbeat deadline fires', () => {
    class SilentSocket {
      static instances: SilentSocket[] = []
      binaryType = 'arraybuffer'
      terminated = false
      private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

      constructor(
        public url: string,
        public protocols: string[]
      ) {
        SilentSocket.instances.push(this)
      }

      on(event: string, cb: (...args: unknown[]) => void): this {
        const list = this.handlers.get(event) ?? []
        list.push(cb)
        this.handlers.set(event, list)
        return this
      }

      once(event: string, cb: (...args: unknown[]) => void): this {
        return this.on(event, cb)
      }

      removeAllListeners(): this {
        this.handlers.clear()
        return this
      }

      send(): void {}

      close(): void {
        this.terminate()
      }

      terminate(): void {
        this.terminated = true
      }

      fire(event: string, ...args: unknown[]): void {
        for (const cb of this.handlers.get(event) ?? []) cb(...args)
      }
    }

    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: 'wss://gw.example/',
      token: TOKEN,
      daemonId: 'd1',
    })
    const timers = manualTimers()
    const t = build(cfg, {
      WebSocketImpl: SilentSocket as unknown as typeof import('ws').WebSocket,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
      heartbeatIntervalMs: 30,
      heartbeatDeadlineMs: 60,
      backoff: { next: () => 10, reset: () => {} },
    })
    t.refresh()
    const first = SilentSocket.instances[0]
    expect(first).toBeDefined()
    first?.fire('open')
    expect(t.status()).toBe('online')

    timers.advance(30)
    timers.advance(60)

    expect(first?.terminated).toBe(true)
    expect(t.status()).toBe('reconnecting')
  })

  it('revokeAndStop tears down and does NOT auto-reconnect (invariant 3)', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')
    const firstCount = gateway.connectionCount()

    t.revokeAndStop('local revoke')
    await waitFor(() => t.status() === 'revoked', 2000, 'revoked')

    // No reconnect: give it a real window.
    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(firstCount)
    expect(t.status()).toBe('revoked')

    await audit.flush()
    expect(
      audit.list().some((r) => r.action === 'session_close' && r.rejectReason === 'revoked')
    ).toBe(true)
  })

  it('a gateway revoked control frame tears the tunnel down with no reconnect', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')
    const firstCount = gateway.connectionCount()

    gateway.sendControl({ t: 'revoked', reason: 'admin revoked device' })
    await waitFor(() => t.status() === 'revoked', 2000, 'revoked via control')

    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(firstCount)
    expect(t.status()).toBe('revoked')
  })

  it('a 4410 close code latches revoked (no retry until refresh)', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')

    // The fixture is the relay: close 4410 Revoked.
    gateway.sendControl({ t: 'revoked', reason: 'closing' })
    await waitFor(() => t.status() === 'revoked', 2000, 'revoked')
    expect(t.status()).toBe('revoked')
  })

  it('refresh() after a disable settles to disabled and closes the socket', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')

    cfg.setEnabled(false)
    t.refresh()
    await waitFor(() => t.status() === 'disabled', 2000, 'disabled')
    expect(t.status()).toBe('disabled')
  })

  it('close() shuts the socket cleanly without status churn or reconnect', async () => {
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, { backoff: { next: () => 20, reset: () => {} } })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')
    const countBefore = gateway.connectionCount()

    await t.close()
    // No reconnect after a graceful close.
    await new Promise((r) => setTimeout(r, 150))
    expect(gateway.connectionCount()).toBe(countBefore)
    tunnel = undefined // already closed; afterEach must not double-close
  })

  it('close() absorbs the expected CONNECTING abort error from ws shutdown', async () => {
    const ConnectingSocket = makeConnectingAbortSocket()
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: 'wss://gw.example/',
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, {
      WebSocketImpl: ConnectingSocket as unknown as typeof import('ws').WebSocket,
    })
    t.refresh()

    expect(t.status()).toBe('connecting')
    await expect(t.close()).resolves.toBeUndefined()
    tunnel = undefined // already closed; afterEach must not double-close
  })

  it('refresh() disabled absorbs the expected CONNECTING abort error from socket teardown', async () => {
    const ConnectingSocket = makeConnectingAbortSocket()
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: 'wss://gw.example/',
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, {
      WebSocketImpl: ConnectingSocket as unknown as typeof import('ws').WebSocket,
    })
    t.refresh()
    expect(t.status()).toBe('connecting')

    cfg.setEnabled(false)
    t.refresh()
    await new Promise((r) => setTimeout(r, 0))

    expect(t.status()).toBe('disabled')
  })

  it('delivers inbound opaque binary frames to the bridge sink', async () => {
    const inbound: Uint8Array[] = []
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, {
      createBridge: () => ({
        attachSocket: () => {},
        onInbound: (frame) => {
          inbound.push(new Uint8Array(frame))
        },
        resetAllStreams: () => {},
        closeDevice: () => {},
      }),
    })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')

    gateway.sendBinary(new Uint8Array([1, 2, 3, 4]))
    await waitFor(() => inbound.length > 0, 2000, 'inbound binary')
    expect([...(inbound[0] ?? [])]).toEqual([1, 2, 3, 4])
  })

  it('a late message from a stale (pre-reconnect) socket does not reach the new bridge sink', async () => {
    // Generation guard: after a drop+reconnect, a zombie socket handler must no-op.
    const sinkCalls: number[] = []
    let bridgeGen = 0
    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: gateway.url,
      token: TOKEN,
      daemonId: 'd1',
    })
    const t = build(cfg, {
      backoff: { next: () => 20, reset: () => {} },
      createBridge: () => {
        const myGen = ++bridgeGen
        return {
          attachSocket: () => {},
          onInbound: () => {
            sinkCalls.push(myGen)
          },
          resetAllStreams: () => {},
          closeDevice: () => {},
        }
      },
    })
    t.refresh()
    await waitFor(() => t.status() === 'online', 2000, 'online')

    gateway.dropDaemon()
    await waitFor(() => gateway.connectionCount() >= 2, 3000, 'reconnected')
    await waitFor(() => t.status() === 'online', 2000, 'online again')

    gateway.sendBinary(new Uint8Array([9]))
    await waitFor(() => sinkCalls.length > 0, 2000, 'inbound after reconnect')
    // Only the FRESH bridge generation receives the frame.
    expect(sinkCalls.every((g) => g === bridgeGen)).toBe(true)
  })

  it('generation guard: a stale socket firing a late message after reconnect is dropped', async () => {
    // This isolates the guard with a controllable injected socket (no fake-gateway needed). We hold
    // a reference to the FIRST socket, force a reconnect, then fire `message` on the stale socket and
    // assert its bytes never reach the live bridge. With the gen guard removed, the late frame leaks
    // onto the fresh generation's bridge and this bites.
    const inboundByGen: number[] = []
    let bridgeGen = 0

    // Minimal controllable WebSocket. Each construction is a fresh "socket" the test can drive.
    class FakeSocket {
      static instances: FakeSocket[] = []
      binaryType = 'arraybuffer'
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
      send(): void {}
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

    const cfg = mutableConfig({
      enabled: true,
      gatewayUrl: 'wss://gw.example/',
      token: TOKEN,
      daemonId: 'd1',
    })
    const timers = manualTimers()
    const t = build(cfg, {
      WebSocketImpl: FakeSocket as unknown as typeof import('ws').WebSocket,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      now: timers.now,
      backoff: { next: () => 10, reset: () => {} },
      createBridge: () => {
        const myGen = ++bridgeGen
        return {
          attachSocket: () => {},
          onInbound: () => {
            inboundByGen.push(myGen)
          },
          resetAllStreams: () => {},
          closeDevice: () => {},
        }
      },
    })
    t.refresh()
    const first = FakeSocket.instances[0]
    expect(first).toBeDefined()
    first?.fire('open')
    expect(t.status()).toBe('online')

    // Drop → schedule reconnect → advance the manual clock to actually reconnect.
    first?.fire('close', 1006, Buffer.from('blip'))
    timers.advance(20)
    const second = FakeSocket.instances[1]
    expect(second).toBeDefined()
    second?.fire('open')
    expect(t.status()).toBe('online')
    expect(bridgeGen).toBe(2)

    // The STALE socket fires a late message. The guard must drop it; only the fresh bridge is live.
    first?.fire('message', Buffer.from([7]), true)
    expect(inboundByGen).toEqual([]) // stale frame dropped, not delivered to gen 2

    // A message on the LIVE socket still flows to the fresh bridge.
    second?.fire('message', Buffer.from([8]), true)
    expect(inboundByGen).toEqual([2])
  })
})
