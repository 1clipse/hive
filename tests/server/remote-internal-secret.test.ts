import { afterEach, describe, expect, test } from 'vitest'

import {
  HIVE_REMOTE_DEVICE_HEADER,
  HIVE_REMOTE_SECRET_HEADER,
} from '../../src/server/remote-loopback-auth.js'
import { startTestServer } from '../helpers/test-server.js'

// The per-boot internal secret (invariant 2): tunnel-originated loopback
// requests carry it; it is regenerated every boot, never persisted, never
// logged, and it is the ONLY escalation to tunnel authority. A 127.0.0.1
// request with absent/forged secret gets normal UI-token treatment (rejected).
//
// These hit the real runtime over real loopback HTTP (no tunnel, no mocks) —
// directly modelling a local attacker hitting 127.0.0.1.

type Server = Awaited<ReturnType<typeof startTestServer>>
const servers: Server[] = []

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close()
  }
})

const boot = async () => {
  const s = await startTestServer()
  servers.push(s)
  return s
}

describe('per-boot internal secret auth', () => {
  test('a /api/* request with no credential is rejected (403)', async () => {
    const s = await boot()
    const res = await fetch(`${s.baseUrl}/api/workspaces`)
    expect(res.status).toBe(403)
  })

  test('a forged/guessed secret gets NO tunnel privilege (403)', async () => {
    const s = await boot()
    for (const guess of ['', 'wrong', 'tunnel', s.store.getUiToken()]) {
      const res = await fetch(`${s.baseUrl}/api/workspaces`, {
        headers: {
          [HIVE_REMOTE_SECRET_HEADER]: guess,
          [HIVE_REMOTE_DEVICE_HEADER]: 'device-attacker',
        },
      })
      expect(res.status, `guess=${JSON.stringify(guess)}`).toBe(403)
    }
  })

  test('the live per-boot secret authorizes a /api/* request (200)', async () => {
    const s = await boot()
    const secret = s.store.getRemoteTunnelSecret()
    expect(typeof secret).toBe('string')
    expect(secret.length).toBeGreaterThan(0)
    const res = await fetch(`${s.baseUrl}/api/workspaces`, {
      headers: {
        [HIVE_REMOTE_SECRET_HEADER]: secret,
        [HIVE_REMOTE_DEVICE_HEADER]: 'device-1',
      },
    })
    expect(res.status).toBe(200)
  })

  test('authorizeRemoteTunnelRequest is constant-time-correct: exact match only', async () => {
    const s = await boot()
    const secret = s.store.getRemoteTunnelSecret()
    const mk = (value: string | undefined) =>
      ({
        headers: value === undefined ? {} : { [HIVE_REMOTE_SECRET_HEADER]: value },
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as Parameters<typeof s.store.authorizeRemoteTunnelRequest>[0]

    expect(s.store.authorizeRemoteTunnelRequest(mk(secret))).toBe(true)
    expect(s.store.authorizeRemoteTunnelRequest(mk(undefined))).toBe(false)
    expect(s.store.authorizeRemoteTunnelRequest(mk(''))).toBe(false)
    expect(s.store.authorizeRemoteTunnelRequest(mk(`${secret}x`))).toBe(false) // longer
    expect(s.store.authorizeRemoteTunnelRequest(mk(secret.slice(0, -1)))).toBe(false) // shorter
    // SAME length, one byte flipped — proves the content comparison, not just the length guard
    // (a wrong-length forgery is rejected before timingSafeEqual ever runs).
    const flipped = `${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`
    expect(flipped.length).toBe(secret.length)
    expect(flipped).not.toBe(secret)
    expect(s.store.authorizeRemoteTunnelRequest(mk(flipped))).toBe(false)
  })

  test('the secret is unique per boot (regenerated, not derived/persisted)', async () => {
    const a = await boot()
    const b = await boot()
    expect(a.store.getRemoteTunnelSecret()).not.toBe(b.store.getRemoteTunnelSecret())
    // also distinct from the UI token (a different credential entirely)
    expect(a.store.getRemoteTunnelSecret()).not.toBe(a.store.getUiToken())
  })

  test('the existing cookie path is unchanged: valid UI cookie still 200, no cookie 403', async () => {
    // invariant 4: wiring the secret accept-path in must not change cookie auth.
    const s = await boot()
    const sessionRes = await fetch(`${s.baseUrl}/api/ui/session`)
    const cookie = sessionRes.headers.get('set-cookie')
    expect(cookie).toBeTruthy()
    const ok = await fetch(`${s.baseUrl}/api/workspaces`, {
      headers: { cookie: cookie as string },
    })
    expect(ok.status).toBe(200)
    const denied = await fetch(`${s.baseUrl}/api/workspaces`)
    expect(denied.status).toBe(403)
  })
})

describe('HARDEN: /api/ui/session refuses tunnel-tagged requests', () => {
  test('a tunnel-tagged request to /api/ui/session does NOT mint a cookie', async () => {
    // Defense in depth (layer 3): even if the bridge whitelist regresses and
    // forwards /api/ui/session, the route itself must refuse a tunnel-tagged
    // caller so the master UI token can never be minted for a remote device.
    const s = await boot()
    const secret = s.store.getRemoteTunnelSecret()
    const res = await fetch(`${s.baseUrl}/api/ui/session`, {
      headers: {
        [HIVE_REMOTE_SECRET_HEADER]: secret,
        [HIVE_REMOTE_DEVICE_HEADER]: 'device-evil',
      },
    })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.status).toBe(403)
  })

  test('a normal (local browser) request to /api/ui/session still mints a cookie', async () => {
    const s = await boot()
    const res = await fetch(`${s.baseUrl}/api/ui/session`)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('hive_ui_token=')
  })
})
