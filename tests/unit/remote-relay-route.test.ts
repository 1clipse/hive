import { describe, expect, it } from 'vitest'

import {
  RELAY_ROUTE_MAGIC,
  unwrapRelayRoute,
  wrapRelayRoute,
} from '../../src/shared/remote-relay-route.js'

describe('relay route envelope (daemon↔gateway hop)', () => {
  it('magic matches the gateway copy (HRT1)', () => {
    // gateway/src/relay-route.ts — RELAY_ROUTE_MAGIC
    expect(Array.from(RELAY_ROUTE_MAGIC)).toEqual([0x48, 0x52, 0x54, 0x31])
  })

  it('wrap/unwrap round-trips the device id and inner frame', () => {
    const inner = new Uint8Array([0x02, 0x01, 0xaa, 0xbb])
    const wrapped = wrapRelayRoute('device-A', inner)
    const out = unwrapRelayRoute(wrapped)
    expect(out.deviceId).toBe('device-A')
    expect(Array.from(out.frame)).toEqual(Array.from(inner))
  })

  it('unprefixed bytes stay unrouted so ConnSalt can broadcast', () => {
    const raw = new Uint8Array([0x02, 0xff, 0x00, 0x01])
    const out = unwrapRelayRoute(raw)
    expect(out.deviceId).toBeNull()
    expect(out.frame).toBe(raw)
  })
})
