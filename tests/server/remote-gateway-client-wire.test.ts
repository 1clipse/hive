import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { postPairConfirm, postPairRevoke } from '../../src/server/remote-gateway-client.js'

// A REAL node:http server standing in for the gateway's POST /pair/confirm endpoint
// (gateway/src/pair.ts). These tests drive postPairConfirm over the real `fetch()` wire path
// that ships in production — no injected fetch, no mocking the seam, definitely no PTY/node-pty.
// If the path, the Bearer auth, or any of the four body fields drift on either side, these bite.
//
// The body contract is verbatim from gateway/src/pair.ts (str(body,'deviceId'|'devicePubkey'|
// 'name'|'boundJti'), all required non-empty strings) and the shape gateway/test/pairing-relay.test.ts
// posts (devicePubkey is an opaque base64url string).

interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

interface FakeGateway {
  url: string
  requests: RecordedRequest[]
  /** HTTP status the /pair/confirm handler answers with (default 200). */
  confirmStatus: number
  revokeStatus: number
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
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const startFakeGateway = async (): Promise<FakeGateway> => {
  const state = { confirmStatus: 200, revokeStatus: 200 }
  const requests: RecordedRequest[] = []

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const body = await readJsonBody(request)
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body,
    })

    if (request.method === 'POST' && url.pathname === '/pair/confirm') {
      if (state.confirmStatus === 200) {
        sendJson(response, 200, { ok: true })
      } else {
        sendJson(response, state.confirmStatus, { error: 'nope' })
      }
      return
    }
    if (request.method === 'POST' && url.pathname === '/pair/revoke') {
      sendJson(
        response,
        state.revokeStatus,
        state.revokeStatus === 200 ? { ok: true } : { error: 'nope' }
      )
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
    get confirmStatus() {
      return state.confirmStatus
    },
    set confirmStatus(value: number) {
      state.confirmStatus = value
    },
    get revokeStatus() {
      return state.revokeStatus
    },
    set revokeStatus(value: number) {
      state.revokeStatus = value
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

const BODY = {
  deviceId: 'dev-abc123',
  devicePubkey: 'cGstYjY0dQ', // base64url, opaque to the gateway
  name: 'Pixel 9',
  boundJti: 'jti-xyz789',
}

describe('postPairConfirm — real gateway wire (default fetch over real HTTP)', () => {
  let gateway: FakeGateway

  beforeEach(async () => {
    gateway = await startFakeGateway()
  })

  afterEach(async () => {
    await gateway.close()
  })

  test('POSTs /pair/confirm with the Bearer daemon token and all four fields verbatim', async () => {
    await expect(
      postPairConfirm({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, BODY)
    ).resolves.toBeUndefined()

    expect(gateway.requests).toHaveLength(1)
    const req = gateway.requests[0]

    // Path + method: mutating the route literal or method off /pair/confirm/POST 404s → reject → fails.
    expect(req?.method).toBe('POST')
    expect(req?.path).toBe('/pair/confirm')

    // Bearer auth carries the daemon token. Dropping the header / wrong scheme → this fails.
    expect(req?.authorization).toBe('Bearer hd_secret_token')
    expect(req?.contentType).toBe('application/json')

    // All four fields, verbatim, no extras. (gateway str() requires every one non-empty.)
    expect(req?.body).toEqual({
      deviceId: 'dev-abc123',
      devicePubkey: 'cGstYjY0dQ',
      name: 'Pixel 9',
      boundJti: 'jti-xyz789',
    })
  })

  test('trims a trailing slash on gatewayUrl before appending /pair/confirm', async () => {
    // gatewayUrl WITH a trailing slash must not produce //pair/confirm. Drop trimSlash → the path
    // recorded becomes //pair/confirm (or 404) → this assert fails.
    await expect(
      postPairConfirm({ gatewayUrl: `${gateway.url}/`, daemonToken: 'hd_secret_token' }, BODY)
    ).resolves.toBeUndefined()

    expect(gateway.requests).toHaveLength(1)
    expect(gateway.requests[0]?.path).toBe('/pair/confirm')
  })

  test('resolves on a 2xx', async () => {
    gateway.confirmStatus = 204
    await expect(
      postPairConfirm({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, BODY)
    ).resolves.toBeUndefined()
  })

  test('throws with the status on a non-2xx (e.g. 401 unauthorized)', async () => {
    gateway.confirmStatus = 401
    // Mutation guard: if the code resolved on non-2xx (dropped the !res.ok check), this rejection
    // assertion fails. The status must surface so the confirm path can refuse to tell the phone OK.
    await expect(
      postPairConfirm({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, BODY)
    ).rejects.toThrow('401')
  })

  test('throws on a 400 missing_fields (the gateway rejected the body)', async () => {
    gateway.confirmStatus = 400
    await expect(
      postPairConfirm({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, BODY)
    ).rejects.toThrow('400')
  })
})

describe('postPairRevoke — real gateway wire', () => {
  let gateway: FakeGateway

  beforeEach(async () => {
    gateway = await startFakeGateway()
  })

  afterEach(async () => {
    await gateway.close()
  })

  test('POSTs /pair/revoke with the Bearer daemon token and deviceId', async () => {
    await expect(
      postPairRevoke({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, 'dev-abc123')
    ).resolves.toBeUndefined()
    expect(gateway.requests).toHaveLength(1)
    expect(gateway.requests[0]?.method).toBe('POST')
    expect(gateway.requests[0]?.path).toBe('/pair/revoke')
    expect(gateway.requests[0]?.authorization).toBe('Bearer hd_secret_token')
    expect(gateway.requests[0]?.body).toEqual({ deviceId: 'dev-abc123' })
  })

  test('rejects 404 because it does not confirm revocation', async () => {
    gateway.revokeStatus = 404
    await expect(
      postPairRevoke({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, 'dev-abc123')
    ).rejects.toBeInstanceOf(Error)
    expect(gateway.requests).toEqual([
      {
        method: 'POST',
        path: '/pair/revoke',
        authorization: 'Bearer hd_secret_token',
        contentType: 'application/json',
        body: { deviceId: 'dev-abc123' },
      },
    ])
  })

  test('throws on 401', async () => {
    gateway.revokeStatus = 401
    await expect(
      postPairRevoke({ gatewayUrl: gateway.url, daemonToken: 'hd_secret_token' }, 'dev-abc123')
    ).rejects.toThrow('401')
  })
})
