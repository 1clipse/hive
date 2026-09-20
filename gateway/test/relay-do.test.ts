import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createDaemon, createDevice, revokeDaemon, revokeDevice, upsertUser } from '../src/db.js'
import { GW_CONTROL_PREFIX, RelayCloseCode } from '../src/relay-do.js'
import { wrapRelayRoute } from '../src/relay-route.js'
import { BROWSER_SESSION_TTL_MS, mintSession, PHONE_SESSION_TTL_MS } from '../src/sessions.js'

// The relay is the gateway's ROUTING half: a per-account Durable Object that pipes ENCRYPTED frames
// between a daemon socket and one-or-more device sockets WITHOUT parsing them (E2E is phone<->daemon,
// M1). These tests are the point of the milestone — they must catch a broken impl:
//   - cross-account IDOR (a phone reaching another account's daemon) → headline #3
//   - opaque forwarding (bytes the relay can't interpret round-trip byte-exact) → #4
//   - revocation kill-switch closing live sockets
//   - device-row gating (browser-login session can't open a device socket; revoked device closed)
//   - WS-upgrade auth transport (subprotocol not cookie) + Origin allowlist
// Nothing here imports M1 frame internals — opaqueness is proven with deliberately non-frame bytes.

const ORIGIN = 'https://app.hivehq.dev'

async function makeUser(sub: string): Promise<string> {
  const row = await upsertUser(env.DB, {
    provider: 'github',
    providerSub: sub,
    email: null,
    now: Date.now(),
    newId: crypto.randomUUID(),
  })
  return row.id
}

async function makeDaemon(userId: string, name = 'box'): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID()
  const token = `hd_${crypto.randomUUID()}`
  await createDaemon(env.DB, { id, userId, name, daemonToken: token, now: Date.now() })
  return { id, token }
}

async function makeDevice(userId: string, name = 'Pixel'): Promise<string> {
  const id = crypto.randomUUID()
  await createDevice(env.DB, { id, userId, name, devicePubkey: 'pk', now: Date.now() })
  return id
}

// A phone session is minted WITH a deviceId (the did claim) — that's what the relay device-path
// requires (a browser-login session has deviceId=null and must be rejected from device sockets).
async function phoneSession(userId: string, deviceId: string): Promise<string> {
  const { token } = await mintSession(env, { userId, deviceId, ttlMs: PHONE_SESSION_TTL_MS })
  return token
}

async function browserSession(userId: string): Promise<string> {
  const { token } = await mintSession(env, {
    userId,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  })
  return token
}

// Open a daemon-side relay socket via the public Worker route (real auth path). Returns the client
// WebSocket (already .accept()ed) plus a queue helper.
async function openDaemonWs(token: string): Promise<TestSocket> {
  const res = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN, 'Sec-WebSocket-Protocol': `bearer.${token}` },
  })
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`daemon upgrade failed: ${res.status}`)
  }
  return acceptSocket(res.webSocket)
}

// Open a phone/device-side relay socket. The session JWT rides Sec-WebSocket-Protocol (HARDEN §6.1
// — browser WebSocket() can't set Authorization; cookie auth on /relay is forbidden).
async function openDeviceWs(
  token: string,
  daemonId: string,
  opts: { origin?: string } = {}
): Promise<TestSocket> {
  const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(daemonId)}`, {
    headers: {
      Upgrade: 'websocket',
      Origin: opts.origin ?? ORIGIN,
      'Sec-WebSocket-Protocol': `bearer.${token}`,
    },
  })
  if (res.status !== 101 || !res.webSocket) {
    throw new Error(`device upgrade failed: ${res.status}`)
  }
  return acceptSocket(res.webSocket)
}

interface TestSocket {
  ws: WebSocket
  // Resolves with the next binary message (as Uint8Array), ignoring control frames.
  nextBinary(): Promise<Uint8Array>
  nextBinaryWithin(timeoutMs: number): Promise<Uint8Array | null>
  // Resolves with the next control frame (string starting with the sentinel), parsed.
  nextControl(): Promise<{ t: string; [k: string]: unknown }>
  nextControlWithin(timeoutMs: number): Promise<{ t: string; [k: string]: unknown } | null>
  // Resolves with the next close {code, reason}.
  nextClose(): Promise<{ code: number; reason: string }>
}

function acceptSocket(ws: WebSocket): TestSocket {
  ws.accept()
  const binary: Uint8Array[] = []
  const control: Array<{ t: string; [k: string]: unknown }> = []
  const closes: Array<{ code: number; reason: string }> = []
  const binWaiters: Array<(v: Uint8Array) => void> = []
  const ctrlWaiters: Array<(v: { t: string }) => void> = []
  const closeWaiters: Array<(v: { code: number; reason: string }) => void> = []

  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data
    if (typeof data === 'string') {
      if (data.startsWith(GW_CONTROL_PREFIX)) {
        const parsed = JSON.parse(data.slice(GW_CONTROL_PREFIX.length)) as { t: string }
        const w = ctrlWaiters.shift()
        if (w) w(parsed)
        else control.push(parsed)
      }
      return
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(0)
    const w = binWaiters.shift()
    if (w) w(bytes)
    else binary.push(bytes)
  })
  ws.addEventListener('close', (ev: CloseEvent) => {
    const c = { code: ev.code, reason: ev.reason }
    const w = closeWaiters.shift()
    if (w) w(c)
    else closes.push(c)
  })

  return {
    ws,
    nextBinary: () =>
      new Promise<Uint8Array>((resolve) => {
        const q = binary.shift()
        if (q) resolve(q)
        else binWaiters.push(resolve)
      }),
    nextBinaryWithin: (timeoutMs) =>
      new Promise((resolve) => {
        const q = binary.shift()
        if (q) {
          resolve(q)
          return
        }
        const waiter = (v: Uint8Array) => {
          clearTimeout(timer)
          resolve(v)
        }
        const timer = setTimeout(() => {
          const i = binWaiters.indexOf(waiter)
          if (i >= 0) binWaiters.splice(i, 1)
          resolve(null)
        }, timeoutMs)
        binWaiters.push(waiter)
      }),
    nextControl: () =>
      new Promise((resolve) => {
        const q = control.shift()
        if (q) resolve(q)
        else ctrlWaiters.push(resolve)
      }),
    nextControlWithin: (timeoutMs) =>
      new Promise((resolve) => {
        const q = control.shift()
        if (q) {
          resolve(q)
          return
        }
        const waiter = (v: { t: string }) => {
          clearTimeout(timer)
          resolve(v)
        }
        const timer = setTimeout(() => {
          const i = ctrlWaiters.indexOf(waiter)
          if (i >= 0) ctrlWaiters.splice(i, 1)
          resolve(null)
        }, timeoutMs)
        ctrlWaiters.push(waiter)
      }),
    nextClose: () =>
      new Promise((resolve) => {
        const q = closes.shift()
        if (q) resolve(q)
        else closeWaiters.push(resolve)
      }),
  }
}

// Lets a forwarded frame propagate through the DO event loop before we assert.
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

afterEach(async () => {
  // Keep revocations/daemons/devices from one test bleeding into the next account-id space. We use
  // fresh random user ids per test so this is belt-and-suspenders, but the revocations table is the
  // hot path the relay consults, so clear it.
  await env.DB.exec('DELETE FROM revocations')
})

describe('relay auth — daemon side', () => {
  test('valid daemon token opens a 101 socket; the DO is keyed by the OWNING account', async () => {
    const userId = await makeUser('relay-daemon-ok')
    const { id, token } = await makeDaemon(userId)

    const daemon = await openDaemonWs(token)
    expect(daemon.ws).toBeTruthy()

    // The DO is reachable ONLY via idFromName(userId). Inspect that exact instance and confirm a
    // daemon socket actually attached there (proves routing keyed on the verified account, test 37).
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const tagged = await runInDurableObject(stub, async (_inst, state) => {
      return state.getWebSockets(`daemon:${id}`).length
    })
    expect(tagged).toBe(1)
    daemon.ws.close()
  })

  test('the daemon 101 echoes the offered subprotocol (a missing echo 1006s the Node ws client → tunnel drop-loop)', async () => {
    // REGRESSION: the relay returned a 101 with NO Sec-WebSocket-Protocol. Browsers tolerate that, but
    // the runtime's Node `ws` client treats "Server sent no subprotocol" as fatal and closes 1006 — so
    // the daemon tunnel reconnect-looped forever and never carried traffic (the phone, a browser WS,
    // worked, which masked it). The 101 MUST echo the exact subprotocol the client offered.
    const userId = await makeUser('relay-subprotocol-echo')
    const { token } = await makeDaemon(userId)
    const res = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${token}`,
      },
    })
    expect(res.status).toBe(101)
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(`bearer.${token}`)
    res.webSocket?.accept()
    res.webSocket?.close()
  })

  test('unknown/garbage daemon token → no 101 (accept-then-figure-out-identity is the bug)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN, 'Sec-WebSocket-Protocol': 'bearer.nope' },
    })
    expect(res.status).not.toBe(101)
    expect(res.webSocket).toBeFalsy()
  })

  test('a REVOKED daemon token cannot open a socket (no oracle, just rejected)', async () => {
    const userId = await makeUser('relay-daemon-revoked')
    const { id, token } = await makeDaemon(userId)
    expect(await revokeDaemon(env.DB, { daemonId: id, userId, now: Date.now() })).toBe(true)

    const res = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${token}`,
      },
    })
    expect(res.status).not.toBe(101)
  })
})

describe('relay auth — device/phone side + cross-account IDOR (#3)', () => {
  test('phone session for its OWN daemon opens a socket once a daemon is live', async () => {
    const userId = await makeUser('relay-device-ok')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    expect(phone.ws).toBeTruthy()

    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const count = await runInDurableObject(
      stub,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(count).toBe(1)
    phone.ws.close()
    daemon.ws.close()
  })

  // HEADLINE IDOR (test 38): account B presents account A's daemonId. Must be 403 and A's DO must
  // never see a peer attach.
  test('phone session for account B presenting account A daemonId → rejected, A unbridged', async () => {
    const alice = await makeUser('idor-alice')
    const bob = await makeUser('idor-bob')
    const bobDevice = await makeDevice(bob)
    const { id: aliceDaemonId, token: aliceToken } = await makeDaemon(alice)

    // Alice's daemon is live. Wait for the socket to actually attach in Alice's DO before we attack:
    // on a cold runtime the daemon-side upgrade and the D1/DO ordering of the next request can race,
    // and we want the cross-account check — not a half-settled runtime — to be what stops Bob. (This
    // barrier also makes "A's DO never gained a device socket" a meaningful assertion: A's DO is awake.)
    const aliceDaemon = await openDaemonWs(aliceToken)
    const aliceStub = env.RELAY.get(env.RELAY.idFromName(alice))
    await runInDurableObject(aliceStub, async (_i, s) => {
      expect(s.getWebSockets(`daemon:${aliceDaemonId}`).length).toBe(1)
    })

    // Bob (valid session) tries to reach Alice's daemonId.
    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(aliceDaemonId)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${await phoneSession(bob, bobDevice)}`,
      },
    })
    // The ownership gate rejects with a hard 403 (relayDevice) — assert that exact code, not just
    // "not 101", so a regression that 500s or silently 101s after a partial check still bites.
    expect(res.status).toBe(403)
    expect(res.webSocket).toBeFalsy()

    // Alice's DO never gained a device socket.
    const aliceDevices = await runInDurableObject(
      aliceStub,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(aliceDevices).toBe(0)
    // And Bob's DO never gained one either (the daemon isn't his).
    const bobStub = env.RELAY.get(env.RELAY.idFromName(bob))
    const bobDevices = await runInDurableObject(
      bobStub,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(bobDevices).toBe(0)

    aliceDaemon.ws.close()
  })

  test('browser-login session (deviceId=null) cannot open a device socket (HARDEN §6.1 device gate)', async () => {
    const userId = await makeUser('relay-browser-no-device')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        // a real browser-login session — no did claim
        'Sec-WebSocket-Protocol': `bearer.${await browserSession(userId)}`,
      },
    })
    expect(res.status).not.toBe(101)
    daemon.ws.close()
  })

  test('a revoked-but-unexpired device session is rejected from the relay', async () => {
    const userId = await makeUser('relay-revoked-device')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)
    const sess = await phoneSession(userId, deviceId)
    const daemon = await openDaemonWs(dtoken)

    // revoke the device (this also cascades the session, but the device gate must reject on its own)
    expect(await revokeDevice(env.DB, { deviceId, userId, now: Date.now() })).toBe(true)

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${sess}`,
      },
    })
    expect(res.status).not.toBe(101)
    daemon.ws.close()
  })

  test('no live daemon → clean DaemonOffline, never bridged to another account', async () => {
    const userId = await makeUser('relay-offline')
    const deviceId = await makeDevice(userId)
    const { id } = await makeDaemon(userId) // created but NOT connected

    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    const close = await phone.nextClose()
    expect(close.code).toBe(RelayCloseCode.DaemonOffline)
  })

  test('unauthenticated WS upgrade (no token) → no 101', async () => {
    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=anything`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    })
    expect(res.status).not.toBe(101)
  })
})

describe('WS upgrade transport hardening (HARDEN §6.1)', () => {
  test('cross-origin WS upgrade is rejected even with a valid subprotocol token', async () => {
    const userId = await makeUser('relay-bad-origin')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: 'https://evil.example',
        'Sec-WebSocket-Protocol': `bearer.${await phoneSession(userId, deviceId)}`,
      },
    })
    expect(res.status).not.toBe(101)
    daemon.ws.close()
  })

  test('cookie-only auth on /relay is rejected (no Bearer subprotocol) — closes CSRF WS surface', async () => {
    const userId = await makeUser('relay-cookie-only')
    const deviceId = await makeDevice(userId)
    const { id } = await makeDaemon(userId)
    const token = await phoneSession(userId, deviceId)

    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        // the only thing a browser auto-sends cross-site — must NOT authenticate the relay
        Cookie: `hive_gw_session=${token}`,
      },
    })
    expect(res.status).not.toBe(101)
  })
})

describe('opaque bidirectional forwarding (#4)', () => {
  // The bytes below are deliberately NOT valid UTF-8 / JSON / M1 frames. If the relay JSON.parses or
  // re-encodes anything, these round-trips break.
  const NON_FRAME = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0xfe, 0x01])

  test('daemon → device: bytes the relay cannot interpret arrive byte-identical', async () => {
    const userId = await makeUser('opaque-d2p')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    await tick()

    daemon.ws.send(NON_FRAME)
    const got = await phone.nextBinary()
    expect(Array.from(got)).toEqual(Array.from(NON_FRAME))

    phone.ws.close()
    daemon.ws.close()
  })

  test('device → daemon: same opaque bytes, reverse direction', async () => {
    const userId = await makeUser('opaque-p2d')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    await tick()

    phone.ws.send(NON_FRAME)
    const got = await daemon.nextBinary()
    expect(Array.from(got)).toEqual(Array.from(NON_FRAME))

    phone.ws.close()
    daemon.ws.close()
  })

  test('a frame with arbitrary M1-header-looking bytes is forwarded unchanged', async () => {
    const userId = await makeUser('opaque-m1ish')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    await tick()

    // looks frame-y (length prefix + type byte + body) but the relay must not care
    const m1ish = new Uint8Array([0x00, 0x00, 0x00, 0x07, 0x02, 0xde, 0xad, 0xbe, 0xef])
    daemon.ws.send(m1ish)
    const got = await phone.nextBinary()
    expect(Array.from(got)).toEqual(Array.from(m1ish))

    phone.ws.close()
    daemon.ws.close()
  })
})

describe('daemon→device routing (no broadcast of sealed frames)', () => {
  test('a routed daemon frame reaches only the target device', async () => {
    const userId = await makeUser('route-two-phones')
    const aDev = await makeDevice(userId, 'A')
    const bDev = await makeDevice(userId, 'B')
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const aP = await openDeviceWs(await phoneSession(userId, aDev), id)
    const bP = await openDeviceWs(await phoneSession(userId, bDev), id)
    await tick()

    const payload = new Uint8Array([0xaa, 0x01, 0x02])
    daemon.ws.send(wrapRelayRoute(aDev, payload))
    const aGot = await aP.nextBinary()
    expect(Array.from(aGot)).toEqual(Array.from(payload))
    expect(await bP.nextBinaryWithin(80)).toBeNull()

    aP.ws.close()
    bP.ws.close()
    daemon.ws.close()
  })

  test('unrouted daemon bytes still reach every device (ConnSalt / legacy)', async () => {
    const userId = await makeUser('route-broadcast-unrouted')
    const aDev = await makeDevice(userId, 'A')
    const bDev = await makeDevice(userId, 'B')
    const { id, token: dtoken } = await makeDaemon(userId)

    const daemon = await openDaemonWs(dtoken)
    const aP = await openDeviceWs(await phoneSession(userId, aDev), id)
    const bP = await openDeviceWs(await phoneSession(userId, bDev), id)
    await tick()

    const raw = new Uint8Array([0x00, 0xff, 0x10, 0x80])
    daemon.ws.send(raw)
    const aGot = await aP.nextBinary()
    const bGot = await bP.nextBinary()
    expect(Array.from(aGot)).toEqual(Array.from(raw))
    expect(Array.from(bGot)).toEqual(Array.from(raw))

    aP.ws.close()
    bP.ws.close()
    daemon.ws.close()
  })
})

describe('per-account isolation under interleave (#3/#4)', () => {
  test('two accounts each with daemon+phone: each phone sees ONLY its own daemon bytes', async () => {
    const a = await makeUser('iso-a')
    const b = await makeUser('iso-b')
    const aDev = await makeDevice(a)
    const bDev = await makeDevice(b)
    const aDaemon = await makeDaemon(a)
    const bDaemon = await makeDaemon(b)

    const aD = await openDaemonWs(aDaemon.token)
    const bD = await openDaemonWs(bDaemon.token)
    const aP = await openDeviceWs(await phoneSession(a, aDev), aDaemon.id)
    const bP = await openDeviceWs(await phoneSession(b, bDev), bDaemon.id)
    await tick()

    const aBytes = new Uint8Array([0xaa, 0x01])
    const bBytes = new Uint8Array([0xbb, 0x02])
    aD.ws.send(aBytes)
    bD.ws.send(bBytes)

    const aGot = await aP.nextBinary()
    const bGot = await bP.nextBinary()
    expect(Array.from(aGot)).toEqual(Array.from(aBytes))
    expect(Array.from(bGot)).toEqual(Array.from(bBytes))

    aP.ws.close()
    bP.ws.close()
    aD.ws.close()
    bD.ws.close()
  })
})

describe('revocation kill-switch closes live sockets', () => {
  test("revoke('session', jti) closes the live device socket with a control frame + 4410", async () => {
    const userId = await makeUser('revoke-live-session')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)
    const { token: sessTok, jti } = await mintSession(env, {
      userId,
      deviceId,
      ttlMs: PHONE_SESSION_TTL_MS,
    })
    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(sessTok, id)
    await tick()

    // revoke via the per-account DO RPC, the way the Worker would on logout
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const closed = await runInDurableObject(stub, async (inst) =>
      inst.revoke('session', jti, 'logout')
    )
    expect(closed).toBe(1)

    const ctl = await phone.nextControl()
    expect(ctl.t).toBe('revoked')
    const close = await phone.nextClose()
    expect(close.code).toBe(RelayCloseCode.Revoked)

    daemon.ws.close()
  })

  test("revoke('daemon', daemonId) closes the live daemon socket (id contract = daemonId, not token hash)", async () => {
    const userId = await makeUser('revoke-live-daemon')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    await tick()

    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const closed = await runInDurableObject(stub, async (inst) =>
      inst.revoke('daemon', id, 'daemon_revoke')
    )
    expect(closed).toBe(1)

    const close = await daemon.nextClose()
    expect(close.code).toBe(RelayCloseCode.Revoked)
  })

  test("revoke('device', deviceId) closes that device's socket", async () => {
    const userId = await makeUser('revoke-live-device')
    const deviceId = await makeDevice(userId)
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    await tick()

    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const closed = await runInDurableObject(stub, async (inst) =>
      inst.revoke('device', deviceId, 'device_revoke')
    )
    expect(closed).toBe(1)
    const close = await phone.nextClose()
    expect(close.code).toBe(RelayCloseCode.Revoked)
    daemon.ws.close()
  })
})

describe('DO internal-header consistency (HARDEN §6.1 minor — forged X-Hive-User)', () => {
  // The DO is only reachable via its binding, but defense-in-depth: a request whose X-Hive-User
  // mismatches ctx.id.name must be refused (catches any future entry path routing on unverified data).
  test('forged X-Hive-User != id.name → 403, no socket attaches', async () => {
    const userId = await makeUser('do-forged-user')
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))

    const status = await runInDurableObject(stub, async (inst) => {
      const req = new Request('https://do/relay', {
        headers: {
          Upgrade: 'websocket',
          'X-Hive-Role': 'daemon',
          'X-Hive-User': 'some-other-account', // != id.name (which is userId)
          'X-Hive-Daemon': crypto.randomUUID(),
          'X-Hive-Token-Hash': 'deadbeef',
        },
      })
      const res = await inst.fetch(req)
      return res.status
    })
    expect(status).toBe(403)

    const attached = await runInDurableObject(stub, async (_i, s) => s.getWebSockets().length)
    expect(attached).toBe(0)
  })

  test('malformed internal header set (daemon role missing token hash) → 400', async () => {
    const userId = await makeUser('do-malformed')
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const status = await runInDurableObject(stub, async (inst) => {
      const req = new Request('https://do/relay', {
        headers: {
          Upgrade: 'websocket',
          'X-Hive-Role': 'daemon',
          'X-Hive-User': userId,
          'X-Hive-Daemon': crypto.randomUUID(),
          // no X-Hive-Token-Hash
        },
      })
      const res = await inst.fetch(req)
      return res.status
    })
    expect(status).toBe(400)
  })
})

describe('replaced daemon (single live daemon per id)', () => {
  test('a second daemon connection for the same id replaces the first (4409)', async () => {
    const userId = await makeUser('replace-daemon')
    const { id, token } = await makeDaemon(userId)
    const first = await openDaemonWs(token)
    await tick()
    const second = await openDaemonWs(token)
    await tick()

    const firstClose = await first.nextClose()
    expect(firstClose.code).toBe(RelayCloseCode.Replaced)

    // Exactly one OPEN daemon socket remains. (A just-closed socket can linger in getWebSockets
    // until its close handshake finishes, so we count by readyState OPEN, not raw membership.)
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const open = await runInDurableObject(stub, async (_i, s) => {
      const OPEN = WebSocket.READY_STATE_OPEN
      return s.getWebSockets(`daemon:${id}`).filter((ws) => ws.readyState === OPEN).length
    })
    expect(open).toBe(1)
    second.ws.close()
  })

  test('replacing a daemon routes device frames to the new OPEN socket and suppresses stale offline', async () => {
    const userId = await makeUser('replace-daemon-route')
    const deviceId = await makeDevice(userId)
    const { id, token } = await makeDaemon(userId)
    const first = await openDaemonWs(token)
    const phone = await openDeviceWs(await phoneSession(userId, deviceId), id)
    await tick()

    const second = await openDaemonWs(token)
    const firstClose = await first.nextClose()
    expect(firstClose.code).toBe(RelayCloseCode.Replaced)

    const online = await phone.nextControl()
    expect(online).toMatchObject({ t: 'peer-online', role: 'daemon' })
    const staleOffline = await phone.nextControlWithin(100)
    expect(staleOffline).not.toMatchObject({ t: 'peer-offline', role: 'daemon' })

    const payload = new Uint8Array([0x72, 0x65, 0x70, 0x6c, 0x61, 0x63, 0x65])
    phone.ws.send(payload)
    const got = await Promise.race([
      second.nextBinary(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('second daemon did not receive device frame')), 500)
      ),
    ])
    expect(Array.from(got)).toEqual(Array.from(payload))

    phone.ws.close()
    second.ws.close()
  })
})

beforeEach(() => {
  // marker so the lint/import of these TTL constants is exercised even if a test is skipped
  expect(BROWSER_SESSION_TTL_MS).toBeLessThan(PHONE_SESSION_TTL_MS)
})

// M5a — the new pairing/mint surface MUST NOT weaken the M2 relay invariants. These reuse the same
// auth helpers and re-assert the data-relay gate alongside the new endpoints.
describe('M5a — data relay gate unchanged + no /api proxy (G1/G2)', () => {
  // G1 — the device gate (relay-do.ts:384) still rejects a browser-login (deviceId=null) session.
  test('unpaired phone (deviceId=null) on /relay → 403 (gate not weakened)', async () => {
    const userId = await makeUser('g1-unpaired-relay')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const res = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${await browserSession(userId)}`,
      },
    })
    expect(res.status).toBe(403)
    expect(res.webSocket).toBeFalsy()
    daemon.ws.close()
  })

  // G2 — the gateway exposes NO /api proxy: the daemon API rides the E2E relay, never a gateway route.
  // A convenience proxy would bypass both E2E and the device gate.
  test('GET /api/* is not a gateway route (404), even with a valid session', async () => {
    const userId = await makeUser('g2-no-api-proxy')
    const deviceId = await makeDevice(userId)
    const res = await SELF.fetch(`${ORIGIN}/api/workspaces`, {
      headers: { Cookie: `hive_gw_session=${await phoneSession(userId, deviceId)}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('M5a — pairing-channel IDOR + minted did session round-trips (G8/G10)', () => {
  // G10 — cross-account IDOR on the pairing channel: B's unpaired session targeting A's daemon → 403,
  // and A's DO never gains a pair socket.
  test("account B's unpaired session on /relay/pair against A's daemon → 403, A unbridged", async () => {
    const alice = await makeUser('g10-alice')
    const bob = await makeUser('g10-bob')
    const { id: aliceDaemonId, token: aliceToken } = await makeDaemon(alice)
    const aliceDaemon = await openDaemonWs(aliceToken)
    const aliceStub = env.RELAY.get(env.RELAY.idFromName(alice))
    await runInDurableObject(aliceStub, async (_i, s) => {
      expect(s.getWebSockets(`daemon:${aliceDaemonId}`).length).toBe(1)
    })

    const { token: bobTok } = await mintSession(env, {
      userId: bob,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    const res = await SELF.fetch(
      `${ORIGIN}/relay/pair?daemonId=${encodeURIComponent(aliceDaemonId)}`,
      {
        headers: {
          'CF-Connecting-IP': crypto.randomUUID(),
          Upgrade: 'websocket',
          Origin: ORIGIN,
          'Sec-WebSocket-Protocol': `bearer.${bobTok}`,
        },
      }
    )
    expect(res.status).toBe(403)
    expect(res.webSocket).toBeFalsy()

    const alicePairSockets = await runInDurableObject(
      aliceStub,
      async (_i, s) => s.getWebSockets('role:pair').length
    )
    expect(alicePairSockets).toBe(0)
    aliceDaemon.ws.close()
  })

  // G8 — a `did` session minted by /pair/session opens the DATA relay (proves the claim shape is the
  // one relayDevice accepts: deviceId !== null, owned device).
  test('a /pair/session-minted did session opens /relay successfully', async () => {
    const userId = await makeUser('g8-roundtrip')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)

    const { token: phoneTok, jti } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    const deviceId = crypto.randomUUID()

    await SELF.fetch(`${ORIGIN}/pair/confirm`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': crypto.randomUUID(),
        'content-type': 'application/json',
        Authorization: `Bearer ${dtoken}`,
      },
      body: JSON.stringify({ deviceId, devicePubkey: 'pk', name: 'Pixel', boundJti: jti }),
    })
    const sessRes = await SELF.fetch(`${ORIGIN}/pair/session`, {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': crypto.randomUUID(),
        'content-type': 'application/json',
        Cookie: `hive_gw_session=${phoneTok}`,
      },
      body: JSON.stringify({ deviceId }),
    })
    expect(sessRes.status).toBe(200)
    const didToken =
      (sessRes.headers.get('Set-Cookie') ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? ''

    const relayRes = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${didToken}`,
      },
    })
    expect(relayRes.status).toBe(101)
    relayRes.webSocket?.accept()
    relayRes.webSocket?.close()
    daemon.ws.close()
  })
})
