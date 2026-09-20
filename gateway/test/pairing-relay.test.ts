import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, test } from 'vitest'
import { createDaemon, createDevice, getDeviceById, upsertUser } from '../src/db.js'
import { GW_CONTROL_PREFIX, RelayCloseCode } from '../src/relay-do.js'
import {
  BROWSER_SESSION_TTL_MS,
  mintSession,
  SESSION_COOKIE_NAME,
  verifySession,
} from '../src/sessions.js'

// M5a — the pairing-relay channel + device-bound session mint. These are the adversarial core of the
// milestone (invariants 1 + 2):
//   - an UNPAIRED phone (deviceId=null session) may open /relay/pair (so first-pairing is possible)
//     but may NEVER open a data relay (/relay) nor have its pairing socket bridged to a loopback path.
//   - the gateway mints a device-bound (`did`) session ONLY after the daemon (post-confirmPairing)
//     created the device row via the daemon-token-authed POST /pair/confirm. No confirm -> no row ->
//     /pair/session 403, no mintSession. A phone has no daemon token, so it can't self-promote.
//   - the bind is single-use (bound_session_jti is cleared on mint), closing the replay + race.

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

async function makeDaemon(userId: string): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID()
  const token = `hd_${crypto.randomUUID()}`
  await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: token, now: Date.now() })
  return { id, token }
}

// An unpaired browser-login session: deviceId=null. This is what a logged-in phone holds BEFORE it
// has paired — exactly the session the pairing channel must accept (and the data relay must reject).
async function unpairedSession(userId: string): Promise<{ token: string; jti: string }> {
  const { token, jti } = await mintSession(env, {
    userId,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  })
  return { token, jti }
}

interface TestSocket {
  ws: WebSocket
  nextText(): Promise<string>
  nextBinary(): Promise<Uint8Array>
  nextClose(): Promise<{ code: number; reason: string }>
}

function acceptSocket(ws: WebSocket): TestSocket {
  ws.accept()
  const texts: string[] = []
  const binary: Uint8Array[] = []
  const closes: Array<{ code: number; reason: string }> = []
  const textWaiters: Array<(v: string) => void> = []
  const binWaiters: Array<(v: Uint8Array) => void> = []
  const closeWaiters: Array<(v: { code: number; reason: string }) => void> = []

  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data
    if (typeof data === 'string') {
      const w = textWaiters.shift()
      if (w) w(data)
      else texts.push(data)
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
    nextText: () =>
      new Promise<string>((resolve) => {
        const q = texts.shift()
        if (q) resolve(q)
        else textWaiters.push(resolve)
      }),
    nextBinary: () =>
      new Promise<Uint8Array>((resolve) => {
        const q = binary.shift()
        if (q) resolve(q)
        else binWaiters.push(resolve)
      }),
    nextClose: () =>
      new Promise((resolve) => {
        const q = closes.shift()
        if (q) resolve(q)
        else closeWaiters.push(resolve)
      }),
  }
}

async function openDaemonWs(token: string): Promise<TestSocket> {
  const res = await SELF.fetch(`${ORIGIN}/relay/daemon`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN, 'Sec-WebSocket-Protocol': `bearer.${token}` },
  })
  if (res.status !== 101 || !res.webSocket) throw new Error(`daemon upgrade failed: ${res.status}`)
  return acceptSocket(res.webSocket)
}

// Every rate-limited endpoint (/relay/pair, /pair/confirm, /pair/session) is per-IP (CF-Connecting-IP)
// under the shared singleWorker runtime — give each call a fresh IP so the codeExchange budget from
// one test (or the daemon suite) can't bleed into another and trip a spurious 429.
function freshIpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'CF-Connecting-IP': crypto.randomUUID(), ...extra }
}

async function openPairWs(token: string, daemonId: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/relay/pair?daemonId=${encodeURIComponent(daemonId)}`, {
    headers: freshIpHeaders({
      Upgrade: 'websocket',
      Origin: ORIGIN,
      'Sec-WebSocket-Protocol': `bearer.${token}`,
    }),
  })
}

async function openPairWsWithCookie(token: string, daemonId: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/relay/pair?daemonId=${encodeURIComponent(daemonId)}`, {
    headers: freshIpHeaders({
      Upgrade: 'websocket',
      Origin: ORIGIN,
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
    }),
  })
}

// POST /pair/confirm helper (daemon-token bearer). Fresh IP per call.
async function postConfirm(
  dtoken: string,
  body: { deviceId: string; devicePubkey: string; name: string; boundJti: string }
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/pair/confirm`, {
    method: 'POST',
    headers: freshIpHeaders({
      'content-type': 'application/json',
      Authorization: `Bearer ${dtoken}`,
    }),
    body: JSON.stringify(body),
  })
}

// POST /pair/session helper (session cookie). Fresh IP per call.
async function postSession(token: string, body: { deviceId: string }): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/pair/session`, {
    method: 'POST',
    headers: freshIpHeaders({
      'content-type': 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
    }),
    body: JSON.stringify(body),
  })
}

// POST /pair/relay-token helper. `cookie` null = send no Cookie header (logged-out caller). Fresh IP
// per call so the session limiter's per-IP fallback (for the no-session case) doesn't bleed budgets.
async function postRelayToken(cookie: string | null): Promise<Response> {
  const headers = freshIpHeaders({ 'content-type': 'application/json' })
  if (cookie !== null) headers.Cookie = `${SESSION_COOKIE_NAME}=${cookie}`
  return SELF.fetch(`${ORIGIN}/pair/relay-token`, { method: 'POST', headers })
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

afterEach(async () => {
  await env.DB.exec('DELETE FROM revocations')
})

// G3 — first-pairing must be possible: an unpaired phone (deviceId=null) opens /relay/pair for its
// OWN account's live daemon → 101. (The data relay rejects this exact session — that's G4/G1.)
describe('pairing channel — unpaired phone admittance (G3)', () => {
  test('unpaired session opens /relay/pair for its own live daemon → 101', async () => {
    const userId = await makeUser('pair-g3')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const { token: phoneTok } = await unpairedSession(userId)
    const res = await openPairWs(phoneTok, id)
    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
    res.webSocket?.accept()
    res.webSocket?.close()
    daemon.ws.close()
  })

  test('unpaired same-origin cookie opens /relay/pair without exposing the token to JS', async () => {
    const userId = await makeUser('pair-g3-cookie')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const { token: phoneTok } = await unpairedSession(userId)

    const res = await openPairWsWithCookie(phoneTok, id)

    expect(res.status).toBe(101)
    expect(res.webSocket).toBeTruthy()
    res.webSocket?.accept()
    res.webSocket?.close()
    daemon.ws.close()
  })

  test('/relay/pair answers app-level heartbeats through the DO auto-response', async () => {
    const userId = await makeUser('pair-g3-heartbeat')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const { token: phoneTok } = await unpairedSession(userId)
    const res = await openPairWsWithCookie(phoneTok, id)
    expect(res.status).toBe(101)
    const pair = acceptSocket(res.webSocket as unknown as WebSocket)

    pair.ws.send('hb:ping')

    await expect(pair.nextText()).resolves.toBe('hb:pong')
    pair.ws.close()
    daemon.ws.close()
  })

  test('cookie fallback on /relay/pair requires an explicit same-origin Origin', async () => {
    const userId = await makeUser('pair-g3-cookie-origin')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)
    const { token: phoneTok } = await unpairedSession(userId)

    const originless = await SELF.fetch(`${ORIGIN}/relay/pair?daemonId=${encodeURIComponent(id)}`, {
      headers: freshIpHeaders({
        Upgrade: 'websocket',
        Cookie: `${SESSION_COOKIE_NAME}=${phoneTok}`,
      }),
    })
    expect(originless.status).toBe(401)
    expect(originless.webSocket).toBeFalsy()

    const crossOrigin = await SELF.fetch(
      `${ORIGIN}/relay/pair?daemonId=${encodeURIComponent(id)}`,
      {
        headers: freshIpHeaders({
          Upgrade: 'websocket',
          Origin: 'https://evil.example',
          Cookie: `${SESSION_COOKIE_NAME}=${phoneTok}`,
        }),
      }
    )
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.webSocket).toBeFalsy()

    daemon.ws.close()
  })
})

// G4 — invariant 1: the pairing socket forwards opaque bytes daemon<->pair, but it can NEVER become a
// data relay. The same did=null token is 403'd on /relay, and the DO routes pair frames only to the
// daemon socket (it never bridges a pair socket to a loopback path — the daemon shim owns that).
describe('pairing channel — pairing-only, never a data relay (G4, invariant 1)', () => {
  test('pair bytes round-trip daemon<->pair, but the same session is barred from /relay', async () => {
    const userId = await makeUser('pair-g4')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })

    const daemon = await openDaemonWs(dtoken)
    const { token: phoneTok } = await unpairedSession(userId)
    const pairRes = await openPairWs(phoneTok, id)
    expect(pairRes.status).toBe(101)
    const pair = acceptSocket(pairRes.webSocket as unknown as WebSocket)
    await tick()

    // opaque bytes pair -> daemon
    const up = new Uint8Array([0x00, 0xff, 0x10, 0x80])
    pair.ws.send(up)
    const gotUp = await daemon.nextBinary()
    expect(Array.from(gotUp)).toEqual(Array.from(up))

    // opaque bytes daemon -> pair
    const down = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    daemon.ws.send(down)
    const gotDown = await pair.nextBinary()
    expect(Array.from(gotDown)).toEqual(Array.from(down))

    // SAME unpaired session can NOT open a data relay socket.
    const relayRes = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${phoneTok}`,
      },
    })
    expect(relayRes.status).toBe(403)
    expect(relayRes.webSocket).toBeFalsy()

    // The DO never gave the unpaired session a device socket.
    const stub = env.RELAY.get(env.RELAY.idFromName(userId))
    const deviceCount = await runInDurableObject(
      stub,
      async (_i, s) => s.getWebSockets('role:device').length
    )
    expect(deviceCount).toBe(0)

    pair.ws.close()
    daemon.ws.close()
  })
})

// G5 — anonymous callers can't open the pairing channel.
describe('pairing channel — auth required (G5)', () => {
  test('logged-out caller on /relay/pair → 401', async () => {
    const res = await SELF.fetch(`${ORIGIN}/relay/pair?daemonId=anything`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    })
    expect(res.status).toBe(401)
    expect(res.webSocket).toBeFalsy()
  })

  test('a PAIRED phone (deviceId set) cannot re-open /relay/pair → 403 (inverse of /relay)', async () => {
    const userId = await makeUser('pair-g5-paired')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })
    const deviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: deviceId,
      userId,
      name: 'Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token } = await mintSession(env, {
      userId,
      deviceId,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    const res = await openPairWs(token, id)
    expect(res.status).toBe(403)
  })

  test('a paired cookie cannot re-open /relay/pair, and data /relay remains bearer-only', async () => {
    const userId = await makeUser('pair-g5-paired-cookie')
    const { id } = await makeDaemon(userId)
    const deviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: deviceId,
      userId,
      name: 'Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token } = await mintSession(env, {
      userId,
      deviceId,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })

    const pairRes = await openPairWsWithCookie(token, id)
    expect(pairRes.status).toBe(403)

    const relayRes = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: freshIpHeaders({
        Upgrade: 'websocket',
        Origin: ORIGIN,
        Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      }),
    })
    expect(relayRes.status).toBe(401)
    expect(relayRes.webSocket).toBeFalsy()
  })
})

// G6 — invariant 2: no confirm -> no device session. /pair/session before any /pair/confirm is 403
// and mints nothing; after the daemon-token-authed /pair/confirm creates the row + binds the jti, the
// SAME caller's /pair/session mints a `did` session. A second /pair/session (replay) is then 403.
describe('device-bound session mint — confirm-gated (G6, invariant 2)', () => {
  test('POST /pair/session before /pair/confirm → 403, no session minted', async () => {
    const userId = await makeUser('pair-g6-noconfirm')
    const { token: phoneTok } = await unpairedSession(userId)
    const deviceId = crypto.randomUUID()

    const res = await postSession(phoneTok, { deviceId })
    expect(res.status).toBe(403)
    // no Set-Cookie minted
    expect(res.headers.get('Set-Cookie')).toBeFalsy()
    // and no device row exists (the daemon never created one)
    expect(await getDeviceById(env.DB, deviceId)).toBeNull()
  })

  test('daemon /pair/confirm creates the row + bind, then the caller /pair/session mints a did session', async () => {
    const userId = await makeUser('pair-g6-confirm')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })
    const { token: phoneTok, jti } = await unpairedSession(userId)
    const deviceId = crypto.randomUUID()

    // 1. the daemon (post-confirmPairing) creates the device row bound to this phone's jti.
    const confirmRes = await postConfirm(dtoken, {
      deviceId,
      devicePubkey: 'pk-b64u',
      name: 'Pixel 9',
      boundJti: jti,
    })
    expect(confirmRes.status).toBe(200)
    const created = await getDeviceById(env.DB, deviceId)
    expect(created?.user_id).toBe(userId)
    expect(created?.bound_session_jti).toBe(jti)

    // 2. the SAME unpaired phone exchanges its session for a device-bound one.
    const sessionRes = await postSession(phoneTok, { deviceId })
    expect(sessionRes.status).toBe(200)
    const setCookie = sessionRes.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)

    // the minted token is a device-bound session: verifySession resolves deviceId === this device.
    const token = setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? ''
    const claims = await verifySession(env, token)
    expect(claims).not.toBeNull()
    expect(claims?.deviceId).toBe(deviceId)
    expect(claims?.userId).toBe(userId)

    // 3. the bind is single-use: a replay with the SAME body is now rejected and mints nothing. The
    // old jti was revoked-first (HARDEN), so the replay can't even re-authenticate (401), and the
    // bind was cleared, so even if it could it'd 403. Either way: rejected, no second Set-Cookie.
    const replay = await postSession(phoneTok, { deviceId })
    expect([401, 403]).toContain(replay.status)
    expect(replay.headers.get('Set-Cookie')).toBeFalsy()
  })
})

// G7 — a phone can't create its own device row, and the jti bind closes the concurrent-session race.
describe('mint trust spine — no self-promotion (G7, invariant 2)', () => {
  test('POST /pair/confirm with a phone session cookie (no daemon token) → 401, no row created', async () => {
    const userId = await makeUser('pair-g7-nodaemon')
    const { token: phoneTok } = await unpairedSession(userId)
    const deviceId = crypto.randomUUID()

    const res = await SELF.fetch(`${ORIGIN}/pair/confirm`, {
      method: 'POST',
      headers: freshIpHeaders({
        'content-type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${phoneTok}`,
      }),
      body: JSON.stringify({ deviceId, devicePubkey: 'pk', name: 'Pixel', boundJti: 'whatever' }),
    })
    expect(res.status).toBe(401)
    expect(await getDeviceById(env.DB, deviceId)).toBeNull()
  })

  test('POST /pair/session with bound_session_jti != claims.jti → 403 (concurrent-session race)', async () => {
    const userId = await makeUser('pair-g7-jti')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })
    const deviceId = crypto.randomUUID()

    // device row bound to a DIFFERENT (stale) jti than the caller will present.
    await postConfirm(dtoken, {
      deviceId,
      devicePubkey: 'pk',
      name: 'Pixel',
      boundJti: 'a-different-jti',
    })

    // a freshly-minted session whose jti will NOT match the bound one.
    const { token: phoneTok } = await unpairedSession(userId)
    const res = await postSession(phoneTok, { deviceId })
    expect(res.status).toBe(403)
    expect(res.headers.get('Set-Cookie')).toBeFalsy()
  })

  test('POST /pair/confirm with an unknown/garbage daemon token → 401', async () => {
    const res = await postConfirm('hd_nope', {
      deviceId: crypto.randomUUID(),
      devicePubkey: 'pk',
      name: 'x',
      boundJti: 'j',
    })
    expect(res.status).toBe(401)
  })

  test('a paired phone (deviceId set) cannot call /pair/session → 403 (only unpaired sessions mint)', async () => {
    const userId = await makeUser('pair-g7-alreadypaired')
    const deviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: deviceId,
      userId,
      name: 'Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token } = await mintSession(env, { userId, deviceId, ttlMs: BROWSER_SESSION_TTL_MS })
    const res = await postSession(token, { deviceId })
    expect(res.status).toBe(403)
  })
})

// Cross-account: a /pair/session against a device row owned by ANOTHER account is rejected.
describe('mint trust spine — cross-account IDOR on /pair/session', () => {
  test("account B's session cannot mint against account A's device row → 403", async () => {
    const alice = await makeUser('pair-idor-alice')
    const bob = await makeUser('pair-idor-bob')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, {
      id,
      userId: alice,
      name: 'box',
      daemonToken: dtoken,
      now: Date.now(),
    })
    const aliceDevice = crypto.randomUUID()
    const { jti: aliceJti } = await unpairedSession(alice)
    await postConfirm(dtoken, {
      deviceId: aliceDevice,
      devicePubkey: 'pk',
      name: 'x',
      boundJti: aliceJti,
    })

    const { token: bobTok } = await unpairedSession(bob)
    const res = await postSession(bobTok, { deviceId: aliceDevice })
    expect(res.status).toBe(403)
  })
})

// /pair/relay-token — the cookie→bearer bridge. The phone WS can't read the HttpOnly cookie nor set
// Authorization, so it asks this endpoint for the RAW value of its own device session JWT. It must be
// gated on a PAIRED (did) session, hand back a token verifySession accepts as a device session, and
// refuse an unpaired or absent session (those have no /relay reach to bridge).
describe('relay-token bridge — paired-device only (M5b)', () => {
  // A real paired-device session, the same way /pair/session would have produced one: a confirmed
  // device row + a minted `did` session.
  async function pairedSession(userId: string): Promise<{ token: string; deviceId: string }> {
    const deviceId = crypto.randomUUID()
    await createDevice(env.DB, {
      id: deviceId,
      userId,
      name: 'Pixel',
      devicePubkey: 'pk',
      now: Date.now(),
    })
    const { token } = await mintSession(env, {
      userId,
      deviceId,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    return { token, deviceId }
  }

  test('paired-device session → 200, returns the SAME token, accepted as a device session', async () => {
    const userId = await makeUser('relaytok-paired')
    const { token: deviceTok, deviceId } = await pairedSession(userId)

    const res = await postRelayToken(deviceTok)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token?: unknown }
    expect(typeof body.token).toBe('string')
    expect((body.token as string).length).toBeGreaterThan(0)

    // It hands back the SAME credential the cookie carries — no new mint (no jti proliferation).
    expect(body.token).toBe(deviceTok)

    // And it is a real device-bound session: verifySession resolves a non-null deviceId for this device.
    const claims = await verifySession(env, body.token as string)
    expect(claims).not.toBeNull()
    expect(claims?.deviceId).toBe(deviceId)
    expect(claims?.userId).toBe(userId)
  })

  test('unpaired (deviceId=null) session → 403, no token', async () => {
    const userId = await makeUser('relaytok-unpaired')
    const { token: phoneTok } = await unpairedSession(userId)

    const res = await postRelayToken(phoneTok)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { token?: unknown; error?: unknown }
    expect(body.token).toBeUndefined()
    expect(body.error).toBe('forbidden')
  })

  test('no session cookie → rejected (no token leaked)', async () => {
    const res = await postRelayToken(null)
    // The sessionRateLimit middleware short-circuits an absent session per-IP with 401 BEFORE the
    // handler (same as /pair/session); if it ever reached the handler it would 403. Either way the
    // caller is rejected and gets NO token — that's the security property. (200 here would mean a
    // logged-out caller pried out a device bearer.)
    expect([401, 403]).toContain(res.status)
    const body = (await res.json()) as { token?: unknown }
    expect(body.token).toBeUndefined()
  })
})

// D2 — the relay conveys the pairing phone's session jti to the daemon. The phone can't read its own
// jti (HttpOnly cookie), so the daemon captures it from the pair `peer-online` control frame and uses
// it as boundJti for /pair/confirm. The relay stays opaque: it forwards an identifier it already holds
// (attach.jti), it does NOT parse any pairing frame.
describe('pairing channel — peer-online carries the phone jti to the daemon (D2)', () => {
  // Resolve the next gateway control frame (GW_CONTROL_PREFIX string) the daemon socket receives.
  function nextControlFrame(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler = (ev: MessageEvent): void => {
        if (typeof ev.data !== 'string' || !ev.data.startsWith(GW_CONTROL_PREFIX)) return
        ws.removeEventListener('message', handler)
        resolve(JSON.parse(ev.data.slice(GW_CONTROL_PREFIX.length)) as Record<string, unknown>)
      }
      ws.addEventListener('message', handler)
    })
  }

  test("a pair-socket attach delivers a 'peer-online' role:'pair' frame carrying the pairing jti", async () => {
    const userId = await makeUser('pair-d2-jti')
    const { id, token: dtoken } = await makeDaemon(userId)
    const daemon = await openDaemonWs(dtoken)

    // Start listening for the daemon's control frame BEFORE the pair socket attaches (the relay emits
    // peer-online on attach, so the frame can arrive before we'd otherwise wire the listener).
    const controlP = nextControlFrame(daemon.ws)

    const { token: phoneTok, jti } = await unpairedSession(userId)
    const res = await openPairWs(phoneTok, id)
    expect(res.status).toBe(101)
    const pair = acceptSocket(res.webSocket as unknown as WebSocket)

    const frame = await controlP
    expect(frame.t).toBe('peer-online')
    expect(frame.role).toBe('pair')
    // The carried jti MUST equal the pairing session's jti — dropping `jti: attach.jti` in relay-do.ts
    // leaves this undefined and fails the assert (mutation guard).
    expect(frame.jti).toBe(jti)

    pair.ws.close()
    daemon.ws.close()
  })
})

describe('POST /pair/revoke — daemon notifies gateway of local revoke', () => {
  test('daemon bearer marks the device revoked and its session jti denied', async () => {
    const userId = await makeUser('pair-revoke-ok')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })
    const { token: phoneTok, jti } = await unpairedSession(userId)
    const deviceId = crypto.randomUUID()
    expect(
      (
        await postConfirm(dtoken, {
          deviceId,
          devicePubkey: 'pk-b64u',
          name: 'Pixel',
          boundJti: jti,
        })
      ).status
    ).toBe(200)
    const sessionRes = await postSession(phoneTok, { deviceId })
    expect(sessionRes.status).toBe(200)
    const setCookie = sessionRes.headers.get('Set-Cookie') ?? ''
    const deviceTok = setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? ''

    const res = await SELF.fetch(`${ORIGIN}/pair/revoke`, {
      method: 'POST',
      headers: freshIpHeaders({
        'content-type': 'application/json',
        Authorization: `Bearer ${dtoken}`,
      }),
      body: JSON.stringify({ deviceId }),
    })
    expect(res.status).toBe(200)
    const row = await getDeviceById(env.DB, deviceId)
    expect(row?.revoked_at).not.toBeNull()

    const relay = await SELF.fetch(`${ORIGIN}/relay?daemonId=${encodeURIComponent(id)}`, {
      headers: {
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Protocol': `bearer.${deviceTok}`,
      },
    })
    expect(relay.status).not.toBe(101)
  })

  test('phone session cookie cannot revoke (401, row stays live)', async () => {
    const userId = await makeUser('pair-revoke-nophone')
    const id = crypto.randomUUID()
    const dtoken = `hd_${crypto.randomUUID()}`
    await createDaemon(env.DB, { id, userId, name: 'box', daemonToken: dtoken, now: Date.now() })
    const { token: phoneTok, jti } = await unpairedSession(userId)
    const deviceId = crypto.randomUUID()
    await postConfirm(dtoken, {
      deviceId,
      devicePubkey: 'pk',
      name: 'Pixel',
      boundJti: jti,
    })

    const res = await SELF.fetch(`${ORIGIN}/pair/revoke`, {
      method: 'POST',
      headers: freshIpHeaders({
        'content-type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${phoneTok}`,
      }),
      body: JSON.stringify({ deviceId }),
    })
    expect(res.status).toBe(401)
    expect((await getDeviceById(env.DB, deviceId))?.revoked_at).toBeNull()
  })
})

// Unused close-code marker so the import is exercised (defensive; mirrors relay-do.test.ts style).
test('RelayCloseCode + GW_CONTROL_PREFIX imports are the gateway values', () => {
  expect(RelayCloseCode.DaemonOffline).toBe(4404)
  expect(GW_CONTROL_PREFIX).toBe('\x00gw:')
})
