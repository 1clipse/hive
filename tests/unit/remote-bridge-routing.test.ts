import { describe, expect, test } from 'vitest'

import {
  ALLOWED_HTTP_PREFIX,
  type BridgeRejectReason,
  classifyOpen,
  isCanonicalPath,
} from '../../src/shared/remote-bridge-routing.js'
import { type StreamMeta, StreamTransport } from '../../src/shared/remote-protocol.js'

const http = (method: string, path: string, hasBody = false): StreamMeta => ({
  transport: StreamTransport.Http,
  http: { method, path, headers: [], hasBody },
})

const ws = (path: string): StreamMeta => ({
  transport: StreamTransport.Ws,
  ws: { path },
})

const wsQuery = (path: string, query: [string, string][]): StreamMeta => ({
  transport: StreamTransport.Ws,
  ws: { path, query },
})

const NUL = String.fromCharCode(0)

// The whitelist is the "not a general localhost proxy" gate. Each reject case
// below is a real bypass that, if the gate were removed or weakened, would turn
// the tunnel into an arbitrary loopback proxy. Reverse allow<->reject and the
// table fails — that is the point.
describe('classifyOpen HTTP whitelist', () => {
  test('allows /api/* routes', () => {
    expect(classifyOpen(http('GET', '/api/workspaces'))).toEqual({
      ok: true,
      transport: 'http',
      method: 'GET',
      path: '/api/workspaces',
    })
    expect(classifyOpen(http('POST', '/api/x'))).toMatchObject({ ok: true, transport: 'http' })
  })

  test('allows query-bearing /api routes (HARDEN: query must not break the gate)', () => {
    // routes-fs / routes-marketplace read query params; rejecting these breaks
    // intended remote functionality.
    expect(classifyOpen(http('GET', '/api/fs/browse?path=/tmp'))).toEqual({
      ok: true,
      transport: 'http',
      method: 'GET',
      path: '/api/fs/browse?path=/tmp',
    })
    expect(classifyOpen(http('GET', '/api/marketplace?lang=en'))).toMatchObject({
      ok: true,
      transport: 'http',
      path: '/api/marketplace?lang=en',
    })
  })

  test('allows the documented HTTP methods', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(classifyOpen(http(m, '/api/x'))).toMatchObject({ ok: true, method: m })
    }
  })

  test('rejects a bad/unknown method', () => {
    expect(classifyOpen(http('CONNECT', '/api/x'))).toEqual({ ok: false, reason: 'bad_method' })
    expect(classifyOpen(http('TRACE', '/api/x'))).toEqual({ ok: false, reason: 'bad_method' })
    expect(classifyOpen(http('get', '/api/x'))).toEqual({ ok: false, reason: 'bad_method' })
  })

  test('blocks /api/ui/session (HARDEN: UI cookie must never leave the trust boundary)', () => {
    // The tunnel is authorized by the per-boot secret; the phone has zero need
    // for the UI cookie. Even though it matches the /api/ prefix, forwarding it
    // would let the phone harvest hive_ui_token. Hard-deny here, before any
    // loopback request can be made.
    const r = classifyOpen(http('GET', '/api/ui/session')) as {
      ok: false
      reason: BridgeRejectReason
    }
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('path_denied')
    // query / casing tricks must not slip past the deny set
    expect(classifyOpen(http('GET', '/api/ui/session?x=1'))).toEqual({
      ok: false,
      reason: 'path_denied',
    })
  })

  test('hard-denies the trust-root pairing paths (HARDEN: layered defense for device approval)', () => {
    // Authority Model: a phone can never self-approve a device. Begin/confirm/reject are desktop-only
    // at the route gate (layer 3); this is the bridge backstop (layer 1). Even if the route gate were
    // bypassed, a forwarded pairing frame is Reset(StreamRefused)+audited path_denied here, never run.
    for (const path of [
      '/api/remote/pairings',
      '/api/remote/pairings/pending',
      '/api/remote/pairings/abc-123/confirm',
      '/api/remote/pairings/abc-123/reject',
    ]) {
      expect(classifyOpen(http('POST', path)), path).toEqual({ ok: false, reason: 'path_denied' })
    }
    // A query / casing trick on the action suffix must not slip past.
    expect(classifyOpen(http('POST', '/api/remote/pairings/X/CONFIRM'))).toEqual({
      ok: false,
      reason: 'path_denied',
    })
    // The EQUAL-AUTHORITY remote routes are NOT denied — a phone may list/revoke/read status+audit.
    expect(classifyOpen(http('GET', '/api/remote/devices'))).toMatchObject({ ok: true })
    expect(classifyOpen(http('POST', '/api/remote/devices/d1/revoke'))).toMatchObject({ ok: true })
    expect(classifyOpen(http('GET', '/api/remote/status'))).toMatchObject({ ok: true })
  })

  const offWhitelistPaths: Array<[string, BridgeRejectReason]> = [
    ['/', 'path_not_whitelisted'],
    ['/etc/passwd', 'path_not_whitelisted'],
    ['/api', 'path_not_whitelisted'], // bare /api, no trailing slash
    ['/apifoo', 'path_not_whitelisted'], // prefix-without-slash bypass
    ['/apifoo/bar', 'path_not_whitelisted'],
    ['/../api/x', 'path_not_canonical'],
    ['/api/../../etc', 'path_not_canonical'],
    ['/api/../secret', 'path_not_canonical'],
    ['/%2e%2e/api', 'path_not_canonical'],
    ['/api/..%2fetc', 'path_not_canonical'],
    ['/api/x%2e%2e', 'path_not_canonical'],
    ['//api', 'path_not_canonical'], // protocol-relative / authority
    ['//evil.com/api', 'path_not_canonical'],
    ['http://evil/api', 'path_not_canonical'], // absolute URL
    ['https://evil/api/x', 'path_not_canonical'],
    ['\\ws\\x', 'path_not_canonical'],
    [`/api/${NUL}x`, 'path_not_canonical'],
    ['', 'path_not_canonical'],
    ['api/x', 'path_not_canonical'], // no leading slash
  ]
  test.each(offWhitelistPaths)('rejects HTTP %s', (path, reason) => {
    expect(classifyOpen(http('GET', path))).toEqual({ ok: false, reason })
  })
})

describe('classifyOpen WS whitelist', () => {
  test('allows terminal io/control and tasks streams', () => {
    expect(classifyOpen(ws('/ws/terminal/run-1/io'))).toEqual({
      ok: true,
      transport: 'ws',
      path: '/ws/terminal/run-1/io',
    })
    expect(classifyOpen(ws('/ws/terminal/run-1/control'))).toMatchObject({
      ok: true,
      transport: 'ws',
    })
    expect(classifyOpen(ws('/ws/tasks/workspace-1'))).toMatchObject({ ok: true, transport: 'ws' })
  })

  test('carries the WS query (clientId/cols/rows) through as a separate field, path stays bare', () => {
    // The query rides StreamMeta.ws.query, NOT the path — the bridge reattaches it onto the loopback
    // URL so terminal-ws-server reads clientId/cols/rows from url.searchParams.
    expect(
      classifyOpen(
        wsQuery('/ws/terminal/run-1/io', [
          ['clientId', 'c1'],
          ['cols', '80'],
          ['rows', '24'],
        ])
      )
    ).toEqual({
      ok: true,
      transport: 'ws',
      path: '/ws/terminal/run-1/io',
      query: [
        ['clientId', 'c1'],
        ['cols', '80'],
        ['rows', '24'],
      ],
    })
  })

  test('rejects a WS query pair carrying a control char (no smuggling past reattach)', () => {
    expect(classifyOpen(wsQuery('/ws/terminal/run-1/io', [['clientId', 'a\nb']]))).toEqual({
      ok: false,
      reason: 'malformed_meta',
    })
    expect(classifyOpen(wsQuery('/ws/terminal/run-1/io', [['', 'x']]))).toEqual({
      ok: false,
      reason: 'malformed_meta',
    })
  })

  const offWhitelistWs: Array<[string, BridgeRejectReason]> = [
    ['/ws', 'path_not_whitelisted'],
    ['/wsx', 'path_not_whitelisted'],
    ['/ws/terminal', 'path_not_whitelisted'],
    ['/ws/terminal/run-1', 'path_not_whitelisted'], // no channel
    ['/ws/terminal/run-1/io/x', 'path_not_whitelisted'], // trailing extra
    ['/ws/terminal/run-1/stderr', 'path_not_whitelisted'], // bad channel
    ['/ws/tasks', 'path_not_whitelisted'],
    ['/ws/tasks/a/b', 'path_not_whitelisted'],
    ['/api/workspaces', 'path_not_whitelisted'], // an /api path is not a WS stream
    ['/ws/../api/x', 'path_not_canonical'],
    ['/ws/terminal/run-1/io?clientId=1', 'path_not_canonical'], // query must ride meta, not path
  ]
  test.each(offWhitelistWs)('rejects WS %s', (path, reason) => {
    expect(classifyOpen(ws(path))).toEqual({ ok: false, reason })
  })
})

describe('classifyOpen malformed meta', () => {
  test('rejects missing http/ws meta', () => {
    expect(classifyOpen({ transport: StreamTransport.Http })).toEqual({
      ok: false,
      reason: 'malformed_meta',
    })
    expect(classifyOpen({ transport: StreamTransport.Ws })).toEqual({
      ok: false,
      reason: 'malformed_meta',
    })
    expect(classifyOpen({ transport: 0x99 as StreamTransport })).toEqual({
      ok: false,
      reason: 'malformed_meta',
    })
  })
})

describe('isCanonicalPath', () => {
  test('accepts plain absolute paths', () => {
    expect(isCanonicalPath('/api/workspaces')).toBe(true)
    expect(isCanonicalPath('/ws/terminal/r/io')).toBe(true)
  })
  test('rejects traversal, encoding, authority, control bytes', () => {
    for (const p of [
      '',
      'api/x',
      '/..',
      '/api/../x',
      '/%2e%2e',
      '/api/%2f',
      '//host',
      'http://x/api',
      `/api${NUL}x`,
    ]) {
      expect(isCanonicalPath(p)).toBe(false)
    }
  })
  test('a query string alone does not make a path non-canonical (HTTP query gate)', () => {
    // isCanonicalPath only validates the path shape; classifyOpen decides whether
    // a query is permitted (HTTP yes, WS no). The query itself is not traversal.
    expect(isCanonicalPath('/api/fs/browse?path=/tmp/x')).toBe(true)
  })
})

test('ALLOWED_HTTP_PREFIX is /api/', () => {
  expect(ALLOWED_HTTP_PREFIX).toBe('/api/')
})
