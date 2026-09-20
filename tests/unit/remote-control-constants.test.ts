import { describe, expect, it } from 'vitest'

import {
  GW_CONTROL_PREFIX,
  isAuthFatalCloseCode,
  RelayCloseCode,
} from '../../src/server/remote-control-constants.js'

// The gateway (gateway/src/relay-do.ts) is a separate Cloudflare-Workers package and is NOT
// import-reachable from src/. The daemon has to re-declare the control-band wire format. This test
// pins those re-declared constants to the exact gateway values so the revoke / close-code wire
// contract can never silently drift. If someone edits relay-do.ts and not here (or vice versa),
// these literal assertions break.
describe('remote control constants (gateway wire contract)', () => {
  it('control-frame sentinel matches the gateway GW_CONTROL_PREFIX', () => {
    // relay-do.ts:29 — const GW_CONTROL_PREFIX = '\x00gw:'
    expect(GW_CONTROL_PREFIX).toBe('\x00gw:')
  })

  it('relay close codes match the gateway RelayCloseCode table', () => {
    // relay-do.ts:32-41
    expect(RelayCloseCode.Normal).toBe(1000)
    expect(RelayCloseCode.ProtocolError).toBe(4400)
    expect(RelayCloseCode.Unauthorized).toBe(4401)
    expect(RelayCloseCode.Forbidden).toBe(4403)
    expect(RelayCloseCode.DaemonOffline).toBe(4404)
    expect(RelayCloseCode.Replaced).toBe(4409)
    expect(RelayCloseCode.Revoked).toBe(4410)
    expect(RelayCloseCode.InternalError).toBe(4500)
  })

  it('only Unauthorized + Revoked latch as auth-fatal; transient closes do not', () => {
    // Fatal → latch 'revoked', never retry until refresh().
    expect(isAuthFatalCloseCode(RelayCloseCode.Unauthorized)).toBe(true)
    expect(isAuthFatalCloseCode(RelayCloseCode.Revoked)).toBe(true)
    // Transient → back off + retry.
    expect(isAuthFatalCloseCode(RelayCloseCode.DaemonOffline)).toBe(false)
    expect(isAuthFatalCloseCode(RelayCloseCode.Replaced)).toBe(false)
    expect(isAuthFatalCloseCode(RelayCloseCode.Normal)).toBe(false)
    expect(isAuthFatalCloseCode(1006)).toBe(false)
  })
})
