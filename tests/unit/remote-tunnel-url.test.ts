import { describe, expect, it } from 'vitest'

import { relayDaemonUrl } from '../../src/server/remote-tunnel.js'

describe('relayDaemonUrl', () => {
  it('upgrades https:// to wss:// and appends /relay/daemon', () => {
    expect(relayDaemonUrl('https://app.hivehq.dev')).toBe('wss://app.hivehq.dev/relay/daemon')
  })
  it('tolerates a trailing slash on the configured base', () => {
    expect(relayDaemonUrl('https://app.hivehq.dev/')).toBe('wss://app.hivehq.dev/relay/daemon')
  })
  it('allows ws:// only for a loopback host (the fake-gateway path)', () => {
    expect(relayDaemonUrl('ws://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/relay/daemon')
  })
  it('rejects insecure ws:// for a non-loopback host (no prod downgrade)', () => {
    expect(() => relayDaemonUrl('ws://app.hivehq.dev')).toThrow(/loopback/)
  })
  it('rejects a non-ws(s) protocol', () => {
    expect(() => relayDaemonUrl('ftp://app.hivehq.dev')).toThrow()
  })
})
