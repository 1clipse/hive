// RelayDO — the gateway's ROUTING half. A per-account Durable Object that pipes ENCRYPTED frames
// between a daemon socket and one-or-more device (phone) sockets. It is an OPAQUE relay: it never
// decrypts E2E payload (phone↔daemon, M1). Daemon→device binary may carry an HRT1 device-id prefix
// (hop metadata only); we strip it and deliver the inner bytes to that device. Unprefixed bytes
// still fan out (ConnSalt). It imports nothing from src/shared/remote-*.ts.
//
// AUTH SPLIT (where credentials are verified):
//   The Worker (relayConnect, below) verifies the credential against D1 BEFORE pinning a DO — we
//   don't wake an account's DO for an unauthenticated socket, and D1 lives at the Worker, not in the
//   DO request path. The Worker derives the DO name from the VERIFIED account (idFromName(userId),
//   never a client param) and forwards the verified identity in internal X-Hive-* headers it fully
//   controls. The DO trusts only the Worker and re-asserts userId === ctx.id.name (defense-in-depth).
//
// HIBERNATION: sockets are accepted via state.acceptWebSocket so idle connections don't burn DO
// duration; per-socket identity survives hibernation via serializeAttachment, and routing is driven
// by tags (getWebSockets(tag)) so the in-memory peer map can be rehydrated after eviction.

import { DurableObject } from 'cloudflare:workers'
import type { Context } from 'hono'
import { getDaemonById, getDeviceById, getLiveDaemonByToken, isRevoked, sha256Hex } from './db.js'
import type { Env } from './env.js'
import { bytesToArrayBuffer, unwrapRelayRoute } from './relay-route.js'
import { readSessionCookie, verifySession } from './sessions.js'

// 'pair' is the M5a pairing-relay role: an UNPAIRED phone (gateway session deviceId=null) relaying
// opaque pairing-handshake frames to its daemon. It can NEVER open a 'device' (data) socket — the
// deviceId!==null gate in relayDevice is the inverse of relayPair's deviceId===null requirement, so a
// given session is admitted to exactly one of the two channels, structurally.
export type SocketRole = 'daemon' | 'device' | 'pair'

// Control-frame sentinel. Gateway<->client control messages (peer presence, revocation) are the ONLY
// thing the relay ever originates or interprets, and they are tagged with this leading sentinel so
// they can never be confused with an opaque binary E2E frame. All non-sentinel messages (every
// binary frame, every string not starting with this) are forwarded verbatim.
export const GW_CONTROL_PREFIX = '\x00gw:'

// WebSocket close codes (4xxx app range). Numbers chosen to mirror their HTTP cousins where natural.
export const RelayCloseCode = {
  Normal: 1000,
  Unauthorized: 4401,
  Forbidden: 4403,
  DaemonOffline: 4404,
  Replaced: 4409,
  Revoked: 4410,
  ProtocolError: 4400,
  InternalError: 4500,
} as const
export type RelayCloseCode = (typeof RelayCloseCode)[keyof typeof RelayCloseCode]

// Gateway-originated control frames (JSON after the sentinel). The phone/daemon clients understand
// these; they are NOT E2E payload.
// `role` includes 'pair' so the daemon can tell a pairing peer (unpaired phone, pairing shim) from a
// device peer (paired phone, data tunnel) on its single /relay/daemon socket. The daemon's data-tunnel
// presence handler must IGNORE role:'pair' for its stream-reset/reconnect logic (see daemon mirror).
// A pair peer-online additionally carries the pairing session's `jti` (D2): the phone can't read its
// own jti (HttpOnly cookie), so the daemon captures it here and uses it as boundJti for /pair/confirm.
// It's opaque routing metadata — the relay forwards an identifier it already holds, NOT pairing
// semantics (invariant 4 holds). Only the pair role carries it; daemon/device peer-online are unchanged.
export type GatewayControl =
  | { t: 'peer-online'; role: SocketRole; jti?: string }
  | { t: 'peer-offline'; role: SocketRole }
  | { t: 'revoked'; reason: string }
  | { t: 'error'; code: RelayCloseCode; message: string }

// Per-socket identity, persisted via serializeAttachment so it survives hibernation. The Worker has
// already verified all of this; the DO never re-derives it from the client.
interface DaemonAttach {
  role: 'daemon'
  userId: string
  daemonId: string
  tokenHash: string
}
interface DeviceAttach {
  role: 'device'
  userId: string
  deviceId: string
  daemonId: string
  jti: string
}
// An unpaired phone's pairing socket. No deviceId (the device row doesn't exist yet) and no tokenHash;
// the jti pins the unpaired gateway session so revoke('session', jti) can tear it down mid-pairing.
interface PairAttach {
  role: 'pair'
  userId: string
  daemonId: string
  jti: string
}
type SocketAttach = DaemonAttach | DeviceAttach | PairAttach

// Tags drive O(1) routing and survive hibernation (getWebSockets(tag) is the source of truth, not an
// in-memory map). Limits (verified 2026): ≤10 tags/socket, ≤256 chars each — we use 2–3 short tags.
const tagRole = (r: SocketRole): string => `role:${r}`
const tagDaemon = (id: string): string => `daemon:${id}`
const tagDevice = (id: string): string => `dev:${id}`
// Pair sockets are keyed by their session jti so revoke('session', jti) can find them (a pairing
// socket has no deviceId tag) and so the DO can enforce one active pair socket per daemon.
const tagPair = (jti: string): string => `pair:${jti}`

// Verified identity the Worker forwards into the DO via internal headers. Never client-reachable.
const H = {
  role: 'X-Hive-Role',
  user: 'X-Hive-User',
  daemon: 'X-Hive-Daemon',
  device: 'X-Hive-Device',
  tokenHash: 'X-Hive-Token-Hash',
  jti: 'X-Hive-Jti',
} as const

function controlFrame(c: GatewayControl): string {
  return GW_CONTROL_PREFIX + JSON.stringify(c)
}

export class RelayDO extends DurableObject<Env> {
  // ---- WebSocket upgrade entry (called by the Worker stub fetch, NOT by clients directly) --------
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    let attach: SocketAttach
    try {
      attach = this.parseIdentity(request)
    } catch {
      return new Response('bad internal identity', { status: 400 })
    }

    // Defense-in-depth: the Worker derived this DO's id from idFromName(verified userId), so the
    // forwarded X-Hive-User MUST re-derive to this exact DO id. A mismatch means something reached
    // fetch() with an account this DO doesn't own (a bypassed Worker / crafted entry path) — refuse.
    // (We compare ids rather than ctx.id.name because the name isn't surfaced on the in-DO id object.)
    if (!this.env.RELAY.idFromName(attach.userId).equals(this.ctx.id)) {
      return new Response('account mismatch', { status: 403 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    if (attach.role === 'device') {
      // A device socket is only useful if its daemon is live; otherwise return a 101 that immediately
      // closes DaemonOffline so the phone gets a clean signal instead of a silent hang.
      const daemonLive = this.ctx.getWebSockets(tagDaemon(attach.daemonId)).length > 0
      this.ctx.acceptWebSocket(server, [
        tagRole('device'),
        tagDevice(attach.deviceId),
        tagDaemon(attach.daemonId),
      ])
      server.serializeAttachment(attach)
      if (!daemonLive) {
        server.close(RelayCloseCode.DaemonOffline, 'daemon_offline')
      } else {
        this.notifyPeers(attach.daemonId, { t: 'peer-online', role: 'device' }, server)
      }
    } else if (attach.role === 'pair') {
      // Pairing channel (M5a). Like a device socket it's useless without a live daemon. POINT-TO-POINT:
      // the daemon shim correlates the lone in-flight pending by socket, so a second concurrent pair
      // socket for the same daemon would make that correlation ambiguous (and could let a second
      // unpaired phone race the handshake). We allow at most one ACTIVE pair socket per daemon and
      // REPLACE any older one (4409) — daemon→pair frames are then routed to that single socket.
      const daemonLive = this.daemonFor(attach.daemonId) !== null
      for (const existing of this.pairSocketsFor(attach.daemonId)) {
        this.closeSocket(existing, RelayCloseCode.Replaced, 'replaced')
      }
      this.ctx.acceptWebSocket(server, [
        tagRole('pair'),
        tagPair(attach.jti),
        tagDaemon(attach.daemonId),
      ])
      server.serializeAttachment(attach)
      if (!daemonLive) {
        server.close(RelayCloseCode.DaemonOffline, 'daemon_offline')
      } else {
        // Carry this pairing session's jti to the daemon (D2 — the boundJti for /pair/confirm).
        this.notifyPeers(
          attach.daemonId,
          { t: 'peer-online', role: 'pair', jti: attach.jti },
          server
        )
      }
    } else {
      // Single live daemon per id: replace any existing one (e.g. reconnect after a network blip).
      for (const existing of this.ctx.getWebSockets(tagDaemon(attach.daemonId))) {
        const ea = existing.deserializeAttachment() as SocketAttach | null
        if (ea?.role === 'daemon') {
          this.closeSocket(existing, RelayCloseCode.Replaced, 'replaced')
        }
      }
      this.ctx.acceptWebSocket(server, [tagRole('daemon'), tagDaemon(attach.daemonId)])
      server.serializeAttachment(attach)
      this.notifyPeers(attach.daemonId, { t: 'peer-online', role: 'daemon' }, server)
    }

    // Idle keepalive that the runtime answers WITHOUT waking the DO (req/resp ≤2048 chars — verified).
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('hb:ping', 'hb:pong'))

    // Echo the negotiated subprotocol back on the 101. Clients carry their bearer token AS the WS
    // subprotocol (`bearer.<token>` — browsers can't set Authorization on WebSocket). The Node `ws`
    // runtime client treats a MISSING echo as fatal ("Server sent no subprotocol") and drops the socket
    // with 1006 — so without this the daemon tunnel reconnect-loops forever and never carries traffic.
    // Browsers tolerate omission, which is why the phone (browser WS) worked while the daemon did not.
    // We MUST echo a value the client actually offered, so reflect the first offered subprotocol verbatim.
    const offered = request.headers.get('Sec-WebSocket-Protocol')
    const accepted = offered?.split(',')[0]?.trim()
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(accepted ? { headers: { 'Sec-WebSocket-Protocol': accepted } } : {}),
    })
  }

  // ---- Opaque forwarding (#4): everything that isn't a sentinel control frame is forwarded as-is --
  override async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const self = ws.deserializeAttachment() as SocketAttach | null
    if (!self) {
      this.closeSocket(ws, RelayCloseCode.InternalError, 'no_attachment')
      return
    }

    // The ONLY messages the relay interprets are its own control frames (sentinel-prefixed strings).
    // No JSON.parse, no frame inspection, no transform on anything else — bytes pass through verbatim.
    if (typeof message === 'string' && message.startsWith(GW_CONTROL_PREFIX)) {
      // M2: clients don't send control frames upstream; ignore unknown control input rather than
      // coupling the relay to a control protocol it doesn't own.
      return
    }

    if (self.role === 'daemon') {
      // Routed binary (HRT1 + deviceId + frame): deliver the inner frame to that device only.
      // Unprefixed binary (ConnSalt / legacy) and TEXT (pairing JSON) still fan out — the gateway
      // does not open E2E ciphertext; the prefix is hop metadata the daemon adds and we strip.
      if (typeof message !== 'string') {
        const routed = unwrapRelayRoute(new Uint8Array(message))
        if (routed.deviceId) {
          const target = this.deviceSocket(self.daemonId, routed.deviceId)
          if (target) this.trySend(target, bytesToArrayBuffer(routed.frame))
          return
        }
        message = bytesToArrayBuffer(routed.frame)
      }
      for (const dev of this.devicesFor(self.daemonId)) {
        this.trySend(dev, message)
      }
      for (const pair of this.pairSocketsFor(self.daemonId)) {
        this.trySend(pair, message)
      }
    } else {
      // device OR pair → the single daemon socket for its daemon. A pair socket's bytes are forwarded
      // verbatim like any other opaque frame; the daemon-side pairing shim (NOT the loopback bridge)
      // is what consumes them, so the gateway never gains pairing semantics (invariant 4 holds).
      const daemon = this.daemonFor(self.daemonId)
      if (daemon) this.trySend(daemon, message)
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const self = ws.deserializeAttachment() as SocketAttach | null
    try {
      ws.close(code, reason)
    } catch {
      // already closing — fine
    }
    if (!self) return
    if (!this.shouldSuppressOffline(self, ws)) {
      this.notifyPeers(self.daemonId, { t: 'peer-offline', role: self.role }, ws)
    }
    // Fire-and-forget liveness write-back (best effort; never blocks the close path).
    this.ctx.waitUntil(this.writeBackSeen(self))
  }

  override async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    const self = ws.deserializeAttachment() as SocketAttach | null
    if (!self) return
    if (!this.shouldSuppressOffline(self, ws)) {
      this.notifyPeers(self.daemonId, { t: 'peer-offline', role: self.role }, ws)
    }
    this.ctx.waitUntil(this.writeBackSeen(self))
  }

  // ---- Revocation kill-switch (RPC the Worker invokes when a credential dies) --------------------
  // id contract (HARDEN §6.2): session → jti, device → deviceId, daemon → daemonId (the routing tag,
  // NOT the token hash). Returns the number of live sockets closed (idempotent: 0 if none attached).
  async revoke(kind: 'session' | 'device' | 'daemon', id: string, reason: string): Promise<number> {
    let victims: WebSocket[]
    if (kind === 'daemon') {
      victims = this.ctx
        .getWebSockets(tagDaemon(id))
        .filter((ws) => (ws.deserializeAttachment() as SocketAttach | null)?.role === 'daemon')
    } else if (kind === 'device') {
      victims = this.ctx.getWebSockets(tagDevice(id))
    } else {
      // session: the jti IS a tag for pair sockets (tagPair) but NOT for device sockets, so scan both
      // — a device socket by its stored jti, plus the directly-tagged pair socket. Logging out an
      // unpaired phone mid-pairing must tear down its pairing socket too (it carries the same jti).
      const deviceVictims = this.ctx.getWebSockets(tagRole('device')).filter((ws) => {
        const a = ws.deserializeAttachment() as SocketAttach | null
        return a?.role === 'device' && a.jti === id
      })
      victims = [...deviceVictims, ...this.ctx.getWebSockets(tagPair(id))]
    }

    let closed = 0
    for (const ws of victims) {
      this.trySend(ws, controlFrame({ t: 'revoked', reason }))
      this.closeSocket(ws, RelayCloseCode.Revoked, reason)
      closed++
    }
    return closed
  }

  // ---- internals ---------------------------------------------------------------------------------

  // Parse + structurally validate the Worker-internal identity headers. Beyond userId===id.name
  // (checked by the caller), each role must carry its full, consistent header set or we 400 — so a
  // future entry path (service binding / crafted runInDurableObject request) can't route on a
  // half-populated identity. Throws on any malformed set.
  private parseIdentity(request: Request): SocketAttach {
    const role = request.headers.get(H.role)
    const userId = request.headers.get(H.user)
    const daemonId = request.headers.get(H.daemon)
    if (!userId || !daemonId) throw new Error('missing user/daemon')

    if (role === 'daemon') {
      const tokenHash = request.headers.get(H.tokenHash)
      if (!tokenHash) throw new Error('daemon missing token hash')
      return { role: 'daemon', userId, daemonId, tokenHash }
    }
    if (role === 'device') {
      const deviceId = request.headers.get(H.device)
      const jti = request.headers.get(H.jti)
      if (!deviceId || !jti) throw new Error('device missing deviceId/jti')
      return { role: 'device', userId, deviceId, daemonId, jti }
    }
    if (role === 'pair') {
      const jti = request.headers.get(H.jti)
      // A pair socket carries NO device header (no device yet). A half-set identity (jti missing, or
      // a stray device header) is malformed → 400, same defense as the daemon/device branches.
      if (!jti) throw new Error('pair missing jti')
      if (request.headers.get(H.device)) throw new Error('pair must not carry deviceId')
      return { role: 'pair', userId, daemonId, jti }
    }
    throw new Error('unknown role')
  }

  private daemonFor(daemonId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(tagDaemon(daemonId))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue
      if ((ws.deserializeAttachment() as SocketAttach | null)?.role === 'daemon') return ws
    }
    return null
  }

  private deviceSocket(daemonId: string, deviceId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(tagDevice(deviceId))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue
      const a = ws.deserializeAttachment() as SocketAttach | null
      if (a?.role === 'device' && a.daemonId === daemonId && a.deviceId === deviceId) return ws
    }
    return null
  }

  private devicesFor(daemonId: string): WebSocket[] {
    return this.ctx
      .getWebSockets(tagDaemon(daemonId))
      .filter(
        (ws) =>
          ws.readyState === WebSocket.READY_STATE_OPEN &&
          (ws.deserializeAttachment() as SocketAttach | null)?.role === 'device'
      )
  }

  private pairSocketsFor(daemonId: string): WebSocket[] {
    return this.ctx
      .getWebSockets(tagDaemon(daemonId))
      .filter(
        (ws) =>
          ws.readyState === WebSocket.READY_STATE_OPEN &&
          (ws.deserializeAttachment() as SocketAttach | null)?.role === 'pair'
      )
  }

  private shouldSuppressOffline(self: SocketAttach, closing: WebSocket): boolean {
    if (self.role !== 'daemon') return false
    for (const ws of this.ctx.getWebSockets(tagDaemon(self.daemonId))) {
      if (ws === closing) continue
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue
      if ((ws.deserializeAttachment() as SocketAttach | null)?.role === 'daemon') return true
    }
    return false
  }

  // Machine-list helper (M5a): the distinct daemonIds with a LIVE daemon socket in this account's DO.
  // Opaque — it reports only which daemonIds are connected, never any frame content or device info.
  // readyState OPEN filters a socket still finishing its close handshake (mirrors the replace test).
  liveDaemonIds(): string[] {
    const OPEN = WebSocket.READY_STATE_OPEN
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets(tagRole('daemon'))) {
      if (ws.readyState !== OPEN) continue
      const a = ws.deserializeAttachment() as SocketAttach | null
      if (a?.role === 'daemon') ids.add(a.daemonId)
    }
    return [...ids]
  }

  // Notify the OTHER side of the same daemon bridge of a presence change. `except` skips the socket
  // whose state just changed. A DAEMON presence change reaches both device AND pair clients (both
  // care whether their machine is up); a device/pair presence change reaches the daemon (so its data
  // tunnel resets in-flight streams, and its pairing shim sees the unpaired phone arrive/leave).
  private notifyPeers(
    daemonId: string,
    control: { t: 'peer-online' | 'peer-offline'; role: SocketRole; jti?: string },
    except: WebSocket
  ): void {
    const frame = controlFrame(control)
    // daemon presence → both client roles; a client (device|pair) presence → the daemon.
    const targets: SocketRole[] = control.role === 'daemon' ? ['device', 'pair'] : ['daemon']
    for (const ws of this.ctx.getWebSockets(tagDaemon(daemonId))) {
      if (ws === except) continue
      const a = ws.deserializeAttachment() as SocketAttach | null
      if (a && targets.includes(a.role)) this.trySend(ws, frame)
    }
  }

  private trySend(ws: WebSocket, data: ArrayBuffer | string): void {
    try {
      ws.send(data)
    } catch {
      // peer is mid-close; drop silently — opaque relay makes no delivery guarantee
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }

  private async writeBackSeen(self: SocketAttach): Promise<void> {
    const { touchDaemonSeen, touchDeviceActive } = await import('./db.js')
    const now = Date.now()
    try {
      if (self.role === 'daemon') await touchDaemonSeen(this.env.DB, self.daemonId, now)
      else if (self.role === 'device') await touchDeviceActive(this.env.DB, self.deviceId, now)
      // 'pair' sockets have no device row yet — nothing to write back.
    } catch {
      // best effort
    }
  }
}

// ===================================================================================================
// Worker-side auth + upgrade (the front door clients hit). Verifies the credential against D1, then
// fetches the per-account DO with the verified identity in internal headers. Returns an HTTP 4xx for
// a rejected upgrade, or the DO's 101 for an accepted one. No oracle: all rejections look the same.
// ===================================================================================================

// Browsers can't set Authorization on WebSocket() — the token rides Sec-WebSocket-Protocol as
// `bearer.<token>` (Worker-readable, NOT auto-sent cross-site like a cookie, so the relay isn't
// CSRF-reachable). We extract it here; the Cookie header is deliberately ignored on /relay.
function bearerFromProtocol(req: Request): string | null {
  const proto = req.headers.get('Sec-WebSocket-Protocol')
  if (!proto) return null
  for (const part of proto.split(',')) {
    const token = part.trim()
    if (token.startsWith('bearer.')) {
      const value = token.slice('bearer.'.length)
      return value.length > 0 ? value : null
    }
  }
  return null
}

export async function relayConnect(
  c: Context<{ Bindings: Env }>,
  role: SocketRole
): Promise<Response> {
  const env = c.env
  const req = c.req.raw

  // Upgrade + Origin allowlist (HARDEN §6.1): reject any cross-origin WS handshake outright so the
  // relay socket can't be opened by a cross-site page (the cookie-CSRF-on-WS surface). Same-origin
  // (Origin == GATEWAY_ORIGIN) only; a missing Origin (server-to-server daemon, not a browser) is
  // allowed — browsers always send Origin, so a cross-site browser attack can never be Origin-less.
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 })
  }
  const origin = req.headers.get('Origin')
  if (origin !== null && origin !== env.GATEWAY_ORIGIN) {
    return new Response('forbidden origin', { status: 403 })
  }

  // The client carries its bearer token AS the WS subprotocol; the DO must echo it on the 101 or the
  // Node `ws` runtime client 1006s ("Server sent no subprotocol"). The DO builds the 101, so forward
  // the offered subprotocol to it (the internal DO request below otherwise has fresh headers only).
  const offeredProtocol = req.headers.get('Sec-WebSocket-Protocol')
  // Daemon/data sockets remain bearer-only. The first-pairing socket is the one exception: a
  // browser-login phone has an HttpOnly session cookie but cannot read it to set a subprotocol. That
  // cookie fallback is allowed only when the browser supplied an explicit same-origin Origin; an
  // Origin-less client can still use bearer, but never cookie auth.
  const token = bearerFromProtocol(req)
  if (role === 'pair') {
    return relayPair(req, env, token, offeredProtocol, origin === env.GATEWAY_ORIGIN)
  }
  if (!token) return new Response('unauthorized', { status: 401 })
  if (role === 'daemon') return relayDaemon(env, token, offeredProtocol)
  return relayDevice(req, env, token, offeredProtocol)
}

// Forward the offered WS subprotocol to the DO so its 101 echoes it (see relayConnect). Mutates + returns.
function withSubprotocol(headers: Headers, offeredProtocol: string | null): Headers {
  if (offeredProtocol) headers.set('Sec-WebSocket-Protocol', offeredProtocol)
  return headers
}

async function relayDaemon(
  env: Env,
  token: string,
  offeredProtocol: string | null
): Promise<Response> {
  const daemon = await getLiveDaemonByToken(env.DB, token)
  if (!daemon) return new Response('unauthorized', { status: 401 })
  // double-check the deny-list by token hash (defense-in-depth vs a race on revoked_at)
  const hash = await sha256Hex(token)
  if (await isRevoked(env.DB, 'daemon', hash)) return new Response('unauthorized', { status: 401 })

  const stub = env.RELAY.get(env.RELAY.idFromName(daemon.user_id))
  const headers = new Headers({
    Upgrade: 'websocket',
    [H.role]: 'daemon',
    [H.user]: daemon.user_id,
    [H.daemon]: daemon.id,
    [H.tokenHash]: hash,
  })
  withSubprotocol(headers, offeredProtocol)
  return stub.fetch(new Request('https://relay-do/connect', { headers }))
}

async function relayDevice(
  req: Request,
  env: Env,
  token: string,
  offeredProtocol: string | null
): Promise<Response> {
  const claims = await verifySession(env, token)
  if (!claims) return new Response('unauthorized', { status: 401 })

  // HARDEN §6.1: only a PAIRED-PHONE session (did present) may open a device socket. A browser-login
  // session has deviceId=null and is rejected — otherwise device-level revocation can't gate the
  // relay (a null-device session has no device to revoke).
  if (claims.deviceId === null) return new Response('forbidden', { status: 403 })

  // The device row must exist, belong to this account, be live, and not be on the deny-list.
  const device = await getDeviceById(env.DB, claims.deviceId)
  if (!device || device.user_id !== claims.userId || device.revoked_at !== null) {
    return new Response('forbidden', { status: 403 })
  }
  if (await isRevoked(env.DB, 'device', claims.deviceId)) {
    return new Response('forbidden', { status: 403 })
  }

  // Cross-account IDOR gate (#3): the daemonId is a CLIENT param, so it must resolve to a daemon
  // OWNED BY the verified account. Anything else (other account's daemon, unknown, revoked) → 403,
  // and we route to the caller's OWN DO (idFromName(claims.userId)) — never the daemon's account.
  const daemonId = new URL(req.url).searchParams.get('daemonId')
  if (!daemonId) return new Response('bad request', { status: 400 })
  const daemon = await getDaemonById(env.DB, daemonId)
  if (!daemon || daemon.user_id !== claims.userId || daemon.revoked_at !== null) {
    return new Response('forbidden', { status: 403 })
  }

  const stub = env.RELAY.get(env.RELAY.idFromName(claims.userId))
  const headers = new Headers({
    Upgrade: 'websocket',
    [H.role]: 'device',
    [H.user]: claims.userId,
    [H.daemon]: daemon.id,
    [H.device]: claims.deviceId,
    [H.jti]: claims.jti,
  })
  withSubprotocol(headers, offeredProtocol)
  return stub.fetch(new Request('https://relay-do/connect', { headers }))
}

// M5a — the pairing-relay channel. The INVERSE of relayDevice: only an UNPAIRED (deviceId===null)
// gateway session may open it (a paired phone has no business re-pairing → 403). It relays OPAQUE
// pairing-handshake frames between the unpaired phone and its daemon; the gateway never parses them
// (invariant 4) and never mints a device session off this socket (invariant 1 — that requires the
// daemon-token-authed /pair/confirm + /pair/session). NO X-Hive-Device header (the device row doesn't
// exist yet). Cross-account IDOR uses the SAME ownership gate as relayDevice.
async function relayPair(
  req: Request,
  env: Env,
  token: string | null,
  offeredProtocol: string | null,
  allowCookieFallback: boolean
): Promise<Response> {
  token ??= allowCookieFallback ? readSessionCookie(req) : null
  if (!token) return new Response('unauthorized', { status: 401 })
  const claims = await verifySession(env, token)
  if (!claims) return new Response('unauthorized', { status: 401 })

  // Inverse of the device gate: a PAIRED phone (did present) is rejected from the pairing channel.
  if (claims.deviceId !== null) return new Response('forbidden', { status: 403 })

  const daemonId = new URL(req.url).searchParams.get('daemonId')
  if (!daemonId) return new Response('bad request', { status: 400 })
  // Cross-account IDOR gate (same as relayDevice): the daemonId must resolve to a daemon OWNED by the
  // verified account; route to the caller's OWN DO, never the daemon's account.
  const daemon = await getDaemonById(env.DB, daemonId)
  if (!daemon || daemon.user_id !== claims.userId || daemon.revoked_at !== null) {
    return new Response('forbidden', { status: 403 })
  }

  const stub = env.RELAY.get(env.RELAY.idFromName(claims.userId))
  const headers = new Headers({
    Upgrade: 'websocket',
    [H.role]: 'pair',
    [H.user]: claims.userId,
    [H.daemon]: daemon.id,
    [H.jti]: claims.jti,
  })
  withSubprotocol(headers, offeredProtocol)
  return stub.fetch(new Request('https://relay-do/connect', { headers }))
}
