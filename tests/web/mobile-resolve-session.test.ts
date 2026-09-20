// @vitest-environment jsdom
//
// mobileResolveSession — the mobile bundle's resolveSession seam (boot-transport's injected crypto).
// It turns the persisted device-session record into a TunnelSession by (1) decoding the directional
// ROOT keys from base64url and (2) fetching the device-bound gateway JWT VALUE from the gateway's
// POST /pair/relay-token (the only bridge a browser WebSocket has to a token it can put in
// Sec-WebSocket-Protocol). Every assert here fails if the product is reversed: a resolveSession that
// skips the fetch, drops credentials, decodes the roots wrong, or swallows a null/!ok.

import { afterEach, describe, expect, test, vi } from 'vitest'

import { fromBase64Url, toBase64Url } from '../../src/shared/remote-crypto.js'
import type { StoredDeviceSession } from '../../web/src/transport/device-session-store.js'
import { mobileResolveSession } from '../../web/src/transport/mobile-resolve-session.js'

// Known root bytes so we can assert the decode is byte-correct (not just "some Uint8Array").
const D2P = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const P2D = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 3) & 0xff)

const storedFixture = (): StoredDeviceSession => ({
  v: 2,
  gatewayUrl: 'https://app.hivehq.dev',
  daemonId: 'daemon-xyz',
  deviceId: 'device-abc',
  deviceKeyPair: { secretKey: 'c2s', publicKey: 'cGs' },
  daemonPublicKey: 'ZHBr',
  rootKeys: { d2p: toBase64Url(D2P), p2d: toBase64Url(P2D) },
  protocolVersion: 2,
  pairedAt: 1,
})

// Install a fake global fetch and capture how it was called.
const installFetch = (
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): Array<{ url: string; init?: RequestInit }> => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) })
    return impl(input, init)
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mobileResolveSession', () => {
  test('POSTs to the TRUSTED bundle origin /pair/relay-token (not stored.gatewayUrl) and derives wss', async () => {
    const calls = installFetch(
      async () => new Response(JSON.stringify({ token: 'device-jwt-value' }), { status: 200 })
    )

    // The stored record's gatewayUrl is a DIFFERENT (untrusted, QR-sourced) value — the code must
    // IGNORE it and pin to window.location.origin (where the bundle was served from).
    const origin = window.location.origin // jsdom default
    const stored = { ...storedFixture(), gatewayUrl: 'https://attacker.example/relay' }
    const session = await mobileResolveSession({
      daemonId: stored.daemonId,
      deviceId: stored.deviceId,
      stored,
    })

    // (1) exactly one fetch, to the TRUSTED origin's relay-token endpoint — NOT the stored value.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${origin}/pair/relay-token`)
    expect(calls[0]?.url).not.toContain('attacker.example')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('include')

    // (2) the token rides through verbatim from the JSON response.
    expect(session.phoneSessionToken).toBe('device-jwt-value')

    // (3) the roots are decoded byte-for-byte from the stored base64url (not re-encoded / swapped).
    expect(Array.from(session.roots.d2p)).toEqual(Array.from(D2P))
    expect(Array.from(session.roots.p2d)).toEqual(Array.from(P2D))
    // and they really are the decode of the stored strings (guards against d2p/p2d swap).
    expect(Array.from(session.roots.d2p)).toEqual(Array.from(fromBase64Url(stored.rootKeys.d2p)))
    expect(Array.from(session.roots.p2d)).toEqual(Array.from(fromBase64Url(stored.rootKeys.p2d)))

    // (4) ids pass through; gatewayUrl is the WSS form of the trusted origin (relay-socket needs wss,
    //     and `new WebSocket('https://…')` would throw).
    expect(session.deviceId).toBe('device-abc')
    expect(session.daemonId).toBe('daemon-xyz')
    expect(session.gatewayUrl).toBe(origin.replace(/^http/, 'ws'))
    expect(session.gatewayUrl.startsWith('ws')).toBe(true)
  })

  test('throws when stored is null (a real bug, not the not-paired path)', async () => {
    const calls = installFetch(async () => new Response('{}', { status: 200 }))
    await expect(
      mobileResolveSession({ daemonId: 'd', deviceId: 'e', stored: null })
    ).rejects.toThrow()
    // and it never reached the network with no record to read.
    expect(calls).toHaveLength(0)
  })

  test('throws when the relay-token fetch is not ok (no half-resolved session)', async () => {
    installFetch(async () => new Response('forbidden', { status: 403 }))
    const stored = storedFixture()
    await expect(
      mobileResolveSession({ daemonId: stored.daemonId, deviceId: stored.deviceId, stored })
    ).rejects.toThrow()
  })
})
