import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, test } from 'vitest'

import { REMOTE_PENDING_REVOKES_KEY } from '../../src/server/remote-config-keys.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

type Server = Awaited<ReturnType<typeof startTestServer>>
const servers: Server[] = []

afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

const startRevokeStub = async (status = 200) => {
  const requests: Array<{ path: string; authorization: string | undefined; body: unknown }> = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        path: new URL(req.url ?? '/', 'http://x').pathname,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setStatus: (next: number) => {
      status = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const seedDevice = (store: Server['store'], id: string) => {
  store.getRemoteDeviceStore().insert({
    id,
    name: 'Phone',
    keys: { d2p: new Uint8Array(32).fill(1), p2d: new Uint8Array(32).fill(2) },
    devicePublicKey: new Uint8Array(32).fill(3),
  })
}

describe('local revoke notifies the gateway', () => {
  test('POST /api/remote/devices/:id/revoke POSTs /pair/revoke with the daemon bearer', async () => {
    const stub = await startRevokeStub()
    try {
      const srv = await startTestServer()
      servers.push(srv)
      srv.store.settings.setAppState('remote_gateway_url', stub.url)
      srv.store.settings.setAppState('remote_daemon_token', 'hd_revoke_token')
      seedDevice(srv.store, 'dev-gw-1')
      const cookie = await getUiCookie(srv.baseUrl)
      const res = await fetch(`${srv.baseUrl}/api/remote/devices/dev-gw-1/revoke`, {
        method: 'POST',
        headers: { cookie },
      })
      expect(res.status).toBe(204)
      await waitFor(
        () => srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value === null
      )
      expect(stub.requests[0]?.authorization).toBe('Bearer hd_revoke_token')
      expect(stub.requests[0]?.body).toEqual({ deviceId: 'dev-gw-1' })
      expect(srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value).toBeNull()
    } finally {
      await stub.close()
    }
  })

  test('failed gateway queues the revoke and retries the same gateway on tunnel-online', async () => {
    const stub = await startRevokeStub(503)
    try {
      const srv = await startTestServer()
      servers.push(srv)
      srv.store.settings.setAppState('remote_gateway_url', stub.url)
      srv.store.settings.setAppState('remote_daemon_token', 'hd_retry_token')
      seedDevice(srv.store, 'dev-queued')
      const cookie = await getUiCookie(srv.baseUrl)

      const res = await fetch(`${srv.baseUrl}/api/remote/devices/dev-queued/revoke`, {
        method: 'POST',
        headers: { cookie },
      })
      expect(res.status).toBe(204)
      await waitFor(() => {
        const raw = srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value
        return raw?.includes('dev-queued') === true
      })

      expect(
        JSON.parse(srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value ?? 'null')
      ).toEqual([{ deviceId: 'dev-queued', gatewayUrl: stub.url }])
      await waitFor(() => stub.requests.length === 1)
      stub.setStatus(200)
      srv.store.setRemoteTunnelStatus('online')
      await waitFor(
        () => srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value === null
      )
      expect(stub.requests).toHaveLength(2)
      expect(stub.requests[1]).toEqual({
        path: '/pair/revoke',
        authorization: 'Bearer hd_retry_token',
        body: { deviceId: 'dev-queued' },
      })
      expect(srv.store.settings.getAppState(REMOTE_PENDING_REVOKES_KEY)?.value).toBeNull()
    } finally {
      await stub.close()
    }
  })
})
