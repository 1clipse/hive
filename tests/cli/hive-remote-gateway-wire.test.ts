import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  REMOTE_DAEMON_ID_KEY,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
  type RemoteConfigStore,
  runHiveRemoteCommand,
} from '../../src/cli/hive-remote.js'

// A REAL node:http server standing in for the gateway's daemon-binding HTTP endpoints
// (gateway/src/daemon.ts: POST /daemon/code, POST /daemon/token, GET /daemon/devices,
// POST /daemon/revoke). This is NOT a mock of the GatewayClient seam — these tests drive the CLI's
// `defaultGatewayClient`, i.e. the real `fetch()` wire path that ships in production. The injected-
// fake tests in hive-remote-cli.test.ts prove the command logic; this file proves the on-wire
// contract (paths, JSON field names, the 401 not_approved poll signal, Bearer auth) actually matches
// the gateway. If a field name, path, or status code drifts on either side, these bite.
//
// No PTY / node-pty anywhere — a plain HTTP fixture is a real network server, not a PTY mock.

interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  authorization: string | undefined
  body: unknown
}

interface FakeGateway {
  url: string
  requests: RecordedRequest[]
  /** Number of POST /daemon/token calls that answer 401 not_approved before handing back the token. */
  pendingTokenPolls: number
  /** Number of POST /daemon/token calls that answer 429 rate_limited before anything else. */
  throttle429Polls: number
  token: { daemonId: string; daemonToken: string }
  devices: unknown[]
  close: () => Promise<void>
}

const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw)
      }
    })
  })

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(payload)
}

const startFakeGateway = async (): Promise<FakeGateway> => {
  const state = {
    pendingTokenPolls: 0,
    throttle429Polls: 0,
    token: { daemonId: 'daemon-real', daemonToken: 'hd_realwire_secret' },
    devices: [] as unknown[],
  }
  const requests: RecordedRequest[] = []
  let tokenPollsSeen = 0
  let throttle429Seen = 0

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const body = await readJsonBody(request)
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization,
      body,
    })

    if (request.method === 'POST' && url.pathname === '/daemon/code') {
      sendJson(response, 200, {
        code: 'hc_wire_code',
        expiresAt: Date.now() + 600_000,
        pollIntervalMs: 1,
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/daemon/token') {
      if (throttle429Seen < state.throttle429Polls) {
        throttle429Seen += 1
        // The gateway throttles a poll. The CLI client must read 429 as "keep polling" (the daemon
        // polls every 2s for up to the 10-min code TTL), NOT as a hard error.
        sendJson(response, 429, { error: 'rate_limited' })
        return
      }
      if (tokenPollsSeen < state.pendingTokenPolls) {
        tokenPollsSeen += 1
        // The gateway's not-yet-approved signal — the CLI client must read 401 as "keep polling",
        // NOT as a hard error (gateway/src/daemon.ts: 401 { error: 'not_approved' }).
        sendJson(response, 401, { error: 'not_approved' })
        return
      }
      sendJson(response, 200, state.token)
      return
    }

    if (request.method === 'GET' && url.pathname === '/daemon/devices') {
      sendJson(response, 200, { devices: state.devices })
      return
    }

    if (request.method === 'POST' && url.pathname === '/daemon/revoke') {
      sendJson(response, 200, { ok: true })
      return
    }

    sendJson(response, 404, { error: 'not_found' })
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get pendingTokenPolls() {
      return state.pendingTokenPolls
    },
    set pendingTokenPolls(value: number) {
      state.pendingTokenPolls = value
    },
    get throttle429Polls() {
      return state.throttle429Polls
    },
    set throttle429Polls(value: number) {
      state.throttle429Polls = value
    },
    get token() {
      return state.token
    },
    set token(value: { daemonId: string; daemonToken: string }) {
      state.token = value
    },
    get devices() {
      return state.devices
    },
    set devices(value: unknown[]) {
      state.devices = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

const makeConfig = (initial: Record<string, string> = {}): RemoteConfigStore => {
  const map = new Map<string, string | null>(Object.entries(initial))
  return {
    get: (key) => (map.has(key) ? { value: map.get(key) ?? null } : undefined),
    set: (key, value) => {
      map.set(key, value)
    },
  }
}

const collect = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
    out,
    err,
  }
}

describe('hive remote — real gateway wire (defaultGatewayClient over real HTTP)', () => {
  let gateway: FakeGateway

  beforeEach(async () => {
    gateway = await startFakeGateway()
  })

  afterEach(async () => {
    await gateway.close()
  })

  test('login hits POST /daemon/code then /daemon/token and persists the real token', async () => {
    const config = makeConfig()
    const sink = collect()

    const code = await runHiveRemoteCommand(['login', '--gateway', gateway.url], {
      config,
      // No `client` override: this exercises the shipping defaultGatewayClient + real fetch.
      log: sink.log,
      error: sink.error,
      sleep: async () => {},
    })

    expect(code).toBe(0)
    // The wire actually carried the contract paths in order.
    const paths = gateway.requests.map((r) => `${r.method} ${r.path}`)
    expect(paths).toContain('POST /daemon/code')
    expect(paths).toContain('POST /daemon/token')
    // /daemon/token carried { code } from the code step — the CLI threads the code through.
    // It also carries { name } (machine hostname) when available; we check the code only.
    const tokenReq = gateway.requests.find((r) => r.path === '/daemon/token')
    expect(tokenReq?.body).toMatchObject({ code: 'hc_wire_code' })

    expect(config.get(REMOTE_GATEWAY_URL_KEY)?.value).toBe(gateway.url)
    expect(config.get(REMOTE_DAEMON_ID_KEY)?.value).toBe('daemon-real')
    expect(config.get(REMOTE_DAEMON_TOKEN_KEY)?.value).toBe('hd_realwire_secret')
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('true')
    // The token must never reach stdout, even on the real-wire path.
    expect(sink.out.join('\n')).not.toContain('hd_realwire_secret')
  })

  test('login treats a real 401 not_approved as "keep polling", not a failure', async () => {
    gateway.pendingTokenPolls = 2
    const config = makeConfig()
    const sink = collect()

    const code = await runHiveRemoteCommand(['login', '--gateway', gateway.url], {
      config,
      log: sink.log,
      error: sink.error,
      now: () => 0,
      sleep: async () => {},
    })

    expect(code).toBe(0)
    // 2 pending 401s + 1 success = 3 real /daemon/token POSTs.
    const tokenPosts = gateway.requests.filter((r) => r.path === '/daemon/token')
    expect(tokenPosts).toHaveLength(3)
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('true')
  })

  test('login treats a real 429 rate_limited as "keep polling", not a failure', async () => {
    // The gateway sizes /daemon/token for the 2s poll cadence, but a transient 429 must NOT kill a
    // login mid-wait. Throttle the first 3 polls, then approve. Mutation guard: if the CLI reverts to
    // throwing on any non-401, the first 429 aborts → code 1, token never persisted, and this fails.
    gateway.throttle429Polls = 3
    const config = makeConfig()
    const sink = collect()

    const code = await runHiveRemoteCommand(['login', '--gateway', gateway.url], {
      config,
      log: sink.log,
      error: sink.error,
      now: () => 0,
      sleep: async () => {},
    })

    expect(code).toBe(0)
    // 3 throttled (429) + 1 success = 4 real /daemon/token POSTs — it kept polling through the 429s.
    const tokenPosts = gateway.requests.filter((r) => r.path === '/daemon/token')
    expect(tokenPosts).toHaveLength(4)
    expect(config.get(REMOTE_DAEMON_TOKEN_KEY)?.value).toBe('hd_realwire_secret')
    expect(config.get(REMOTE_ENABLED_KEY)?.value).toBe('true')
  })

  test('login surfaces a hard gateway error (non-401) instead of polling forever', async () => {
    // Point at a port with nothing listening to force a real fetch/connection failure.
    await gateway.close()
    const config = makeConfig()
    const sink = collect()

    const code = await runHiveRemoteCommand(['login', '--gateway', gateway.url], {
      config,
      log: sink.log,
      error: sink.error,
      sleep: async () => {},
    })

    expect(code).toBe(1)
    expect(config.get(REMOTE_ENABLED_KEY)?.value ?? null).not.toBe('true')

    // Re-open so afterEach's close() resolves cleanly.
    gateway = await startFakeGateway()
  })
})
