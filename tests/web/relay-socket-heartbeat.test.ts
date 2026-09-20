// @vitest-environment jsdom
//
// H-NET-1 — the phone must arm a pong deadline mirroring the daemon's. It sends HB_PING every 20s; on
// a half-open socket (NAT drop, no FIN) the send succeeds into the void and the phone would otherwise
// only learn the socket is dead via TCP timeout (minutes on mobile), so in-flight fetches hang far
// longer than they should. The fix: track the oldest unanswered ping and force-close + reconnect if no
// hb:pong arrives within the deadline. This test drives a socket that goes silent (no pong) and asserts
// the relay force-closes (onDown) within the deadline, then reconnects.

import { describe, expect, test, vi } from 'vitest'

import { HB_PING, HB_PONG, RelayCloseCode } from '../../src/server/remote-control-constants.js'
import { createRelaySocket } from '../../web/src/transport/relay-socket.js'

// A WebSocket double for the relay. It records text sends (heartbeat pings), lets the test deliver a
// pong, and exposes a forced close. Mirrors only what relay-socket uses.
class FakeWs {
  static instances: FakeWs[] = []
  readonly OPEN = 1
  readyState = 0
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly sentText: string[] = []
  closedByClient = false

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeWs.instances.push(this)
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') this.sentText.push(data)
  }
  deliverPong(): void {
    this.onmessage?.({ data: HB_PONG })
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closedByClient = true
    this.onclose?.({ code: 1006 })
  }
}

describe('relay-socket heartbeat — phone pong deadline (H-NET-1)', () => {
  test('a missed pong force-closes the socket within the deadline (no minutes-long hang)', () => {
    vi.useFakeTimers()
    try {
      FakeWs.instances.length = 0
      const downs: Array<{ code: number; authFatal: boolean }> = []
      let ups = 0
      createRelaySocket(
        {
          gatewayUrl: 'wss://gw.test',
          daemonId: 'd1',
          phoneSessionToken: 'jwt',
          WebSocketImpl: FakeWs as unknown as typeof WebSocket,
          heartbeatMs: 20_000,
        },
        {
          onFrame: () => {},
          onControl: () => {},
          onUp: () => {
            ups += 1
          },
          onDown: (info) => downs.push({ code: info.code, authFatal: info.authFatal }),
        }
      )
      const first = FakeWs.instances[0]
      if (!first) throw new Error('no socket opened')
      first.open()
      expect(ups).toBe(1)

      // 20s later the phone sends a ping...
      vi.advanceTimersByTime(20_000)
      expect(first.sentText.filter((t) => t === HB_PING).length).toBeGreaterThanOrEqual(1)
      expect(first.closedByClient).toBe(false)

      // ...and the gateway never pongs (half-open socket). After the pong deadline the relay must
      // force-close and surface a transient onDown so a reconnect is scheduled. Without the fix the
      // socket stays "open" forever and downs stays empty.
      vi.advanceTimersByTime(30_000)
      expect(first.closedByClient).toBe(true)
      expect(downs.length).toBeGreaterThanOrEqual(1)
      expect(downs[0]?.authFatal).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('H-NET-2: consecutive 4404 reconnects are capped and surface a terminal daemon-offline state', () => {
    vi.useFakeTimers()
    try {
      FakeWs.instances.length = 0
      const downs: Array<{ code: number; authFatal: boolean; daemonOffline?: boolean }> = []
      // Every upgrade fails 4404 DaemonOffline (the daemon is down). The relay backs off + retries; with
      // the H-NET-2 cap it must STOP after a bounded number of consecutive 4404s and surface a terminal
      // daemonOffline onDown (no nextRetryInMs) instead of looping forever.
      const relay = createRelaySocket(
        {
          gatewayUrl: 'wss://gw.test',
          daemonId: 'd1',
          phoneSessionToken: 'jwt',
          WebSocketImpl: FakeWs as unknown as typeof WebSocket,
          maxOfflineRetries: 3,
        },
        {
          onFrame: () => {},
          onControl: () => {},
          onUp: () => {},
          onDown: (info) =>
            downs.push({
              code: info.code,
              authFatal: info.authFatal,
              ...(info.daemonOffline ? { daemonOffline: true } : {}),
            }),
        }
      )
      // Drive the loop: each new socket closes 4404 before opening, then the backoff timer fires the
      // next attempt. A bounded number of times.
      for (let i = 0; i < 10; i++) {
        const ws = FakeWs.instances.at(-1)
        if (!ws) break
        ws.readyState = 3
        ws.onclose?.({ code: RelayCloseCode.DaemonOffline })
        vi.advanceTimersByTime(60_000) // fire any scheduled backoff reconnect
      }

      // It must have given up: the last onDown is the terminal daemonOffline (no further retries armed).
      const offline = downs.filter((d) => d.daemonOffline)
      expect(offline.length).toBeGreaterThanOrEqual(1)
      // And it stopped opening new sockets once it gave up — far fewer than the 10 loop turns.
      expect(FakeWs.instances.length).toBeLessThan(10)
      // It is resumable on user action: resume() reopens a socket.
      const before = FakeWs.instances.length
      relay.resume()
      expect(FakeWs.instances.length).toBe(before + 1)
      relay.close()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a timely pong clears the deadline — a healthy socket is never force-closed', () => {
    vi.useFakeTimers()
    try {
      FakeWs.instances.length = 0
      const downs: number[] = []
      createRelaySocket(
        {
          gatewayUrl: 'wss://gw.test',
          daemonId: 'd1',
          phoneSessionToken: 'jwt',
          WebSocketImpl: FakeWs as unknown as typeof WebSocket,
          heartbeatMs: 20_000,
        },
        {
          onFrame: () => {},
          onControl: () => {},
          onUp: () => {},
          onDown: (info) => downs.push(info.code),
        }
      )
      const ws = FakeWs.instances[0]
      if (!ws) throw new Error('no socket opened')
      ws.open()

      // Each ping is promptly ponged (well inside the 10s deadline). Over several cycles the socket
      // stays healthy: the deadline is always cleared before it can fire, so it's never force-closed.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(20_000) // ping fires + deadline armed
        vi.advanceTimersByTime(1_000) // pong latency
        ws.deliverPong() // clears the deadline
      }
      expect(ws.closedByClient).toBe(false)
      expect(downs.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
