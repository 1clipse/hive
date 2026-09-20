// Daemon-side pairing-over-tunnel glue (plan steps 2 + 4, decisions D1/D2/D3).
//
// Pairing rides the SAME outbound gateway socket as the data tunnel, but as JSON TEXT frames (the
// data plane is binary). The relay forwards them opaque between the unpaired phone's `/relay/pair`
// socket and this daemon's `/relay/daemon` socket. This driver is the daemon half of the wire:
//
//   phone  -> daemon : {"t":"hello", devicePublicKey, sessionSalt, proposedName?}   (b64url keys)
//   daemon -> phone  : {"t":"pair-ack", daemonPublicKey, daemonId, deviceId, protocolVersion}
//      ... the human compares the 6-digit SAS on phone vs desktop and confirms ON THE DESKTOP ...
//   daemon -> phone  : {"t":"confirmed", deviceId}
//
// The driver does NOT own the socket — the tunnel injects `send(obj)` (JSON-stringify + socket.send)
// and routes inbound text frames here. It DOES own the active-pairing association (D1: one at a time
// per daemon — the relay allows a single pair socket, replacing the older with 4409) plus the boundJti
// the gateway conveys (D2: the phone can't read its own HttpOnly-cookie jti, so the relay's pair
// `peer-online` carries it; the daemon captures it and uses it as boundJti for /pair/confirm).
//
// confirm() is the desktop-confirm sequence (D3): local row insert (the trust-root write, owned by the
// engine) -> AWAIT POST /pair/confirm (creates the gateway device row keyed by boundJti) -> only THEN
// tell the phone `confirmed`. Ordering guarantees the phone's subsequent /pair/session finds the row
// (no 403 race). If the gateway POST fails OR boundJti never arrived, we do NOT send `confirmed` — the
// phone is left to re-scan rather than told a half-finished pairing succeeded.

import {
  fromBase64Url,
  SESSION_SALT_LEN,
  toBase64Url,
  X25519_KEY_LEN,
} from '../shared/remote-crypto.js'
import type { PostPairConfirmDeps } from './remote-gateway-client.js'
import type { RemotePairing } from './remote-pairing.js'

// The inbound pairing envelopes this driver understands. Only `hello` is phone->daemon over the
// tunnel today; the union is kept open (discriminated on `t`) so an unknown/forged `t` is ignored
// rather than mis-parsed.
export interface PairingHelloFrame {
  t: 'hello'
  devicePublicKey: string // base64url, 32 bytes
  sessionSalt: string // base64url, 32 bytes
  proposedName?: string
}

export type PairingInboundFrame = PairingHelloFrame

// Daemon->phone frames the driver emits via `send`.
export interface PairAckFrame {
  t: 'pair-ack'
  daemonPublicKey: string // base64url
  daemonId: string
  deviceId: string
  protocolVersion: number
}
export interface ConfirmedFrame {
  t: 'confirmed'
  deviceId: string
}
export interface RejectedFrame {
  t: 'rejected'
  reason: 'expired'
}
export type PairingOutboundFrame = PairAckFrame | ConfirmedFrame | RejectedFrame

export interface RemotePairingTunnelDeps {
  pairing: RemotePairing
  /** Emit a JSON text frame over the live tunnel socket (the relay fans it to the pair socket). */
  send: (frame: PairingOutboundFrame) => void
  /** D5 seam: POST /pair/confirm to the gateway. Injected so tests don't hit the real fetch path. */
  postPairConfirm: (deps: PostPairConfirmDeps, body: PairConfirmArgs) => Promise<void>
  getGatewayUrl: () => string | null
  getDaemonToken: () => string | null
}

// Body fields the driver hands postPairConfirm (mirrors PairConfirmBody — re-declared so the driver
// doesn't import the concrete shape and the deps stay seam-only).
export interface PairConfirmArgs {
  deviceId: string
  devicePubkey: string
  name: string
  boundJti: string
}

// The active tunnel pairing the driver tracks (D1 — at most one). Captured across the hello so confirm
// has the deviceId + devicePublicKey + boundJti without re-reading the engine's secret surface.
interface ActivePairing {
  pairingId: string
  deviceId: string
  devicePublicKey: Uint8Array
  boundJti: string | null
  name: string | null
}

export interface RemotePairingTunnel {
  /**
   * The gateway told us a pair socket attached for this daemon, carrying the pairing session's jti
   * (D2). A NEW peer-online RESETS the active pairing (D1 replace race — the relay swapped the pair
   * socket, so any half-done handshake is now stale and must not be confirmable) and records the jti
   * so the next hello binds to it.
   */
  onPeerOnline(jti: string | undefined): void
  /** A TEXT frame arrived on the tunnel. Parse + route; on `hello`, run the daemon handshake half. */
  onPairingFrame(text: string): void
  /**
   * Desktop confirm (D3). Insert the local row (trust root), POST /pair/confirm, then send
   * `confirmed`. Returns the local RemoteDeviceRecord (or null if the engine wouldn't confirm).
   * Throws if the gateway POST fails or boundJti is missing — the route surfaces it and the phone is
   * NOT told confirmed.
   */
  confirm(pairingId: string, name?: string): Promise<ReturnType<RemotePairing['confirmPairing']>>
}

const isHello = (v: unknown): v is PairingHelloFrame =>
  typeof v === 'object' &&
  v !== null &&
  (v as { t?: unknown }).t === 'hello' &&
  typeof (v as { devicePublicKey?: unknown }).devicePublicKey === 'string' &&
  typeof (v as { sessionSalt?: unknown }).sessionSalt === 'string'

export const createRemotePairingTunnel = (deps: RemotePairingTunnelDeps): RemotePairingTunnel => {
  // At most one active pairing per daemon (D1). A null boundJti means the gateway peer-online either
  // hasn't arrived yet or didn't carry a jti — confirm() refuses in that case.
  let active: ActivePairing | null = null
  // The jti the most recent pair peer-online carried. Captured separately from `active` because the
  // peer-online arrives BEFORE the hello (the relay emits it on pair-socket attach); the hello then
  // adopts it. A new peer-online overwrites this and resets `active`.
  let pendingBoundJti: string | null = null

  const onPeerOnline = (jti: string | undefined): void => {
    // D1 replace race: a new pair socket (possibly a different phone) supersedes any in-flight
    // handshake. Drop the stale active pairing so a confirm on it can never go through.
    active = null
    pendingBoundJti = jti ?? null
  }

  const onPairingFrame = (text: string): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isHello(parsed)) return

    let devicePublicKey: Uint8Array
    let sessionSalt: Uint8Array
    try {
      devicePublicKey = fromBase64Url(parsed.devicePublicKey)
      sessionSalt = fromBase64Url(parsed.sessionSalt)
    } catch {
      return
    }
    if (devicePublicKey.length !== X25519_KEY_LEN || sessionSalt.length !== SESSION_SALT_LEN) {
      return
    }

    // D1: map the hello to the daemon's single awaiting_handshake pending pairing. The relay only
    // lets one pair socket attach, so there is at most one pending the inbound hello can belong to.
    // (The phone's hello carries no pairingId — that handle lives only on the desktop.)
    const pairingId = deps.pairing.findAwaitingHandshake()
    if (!pairingId) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }

    const view = deps.pairing.submitDeviceHello({
      pairingId,
      devicePublicKey,
      sessionSalt,
      ...(parsed.proposedName !== undefined ? { proposedName: parsed.proposedName } : {}),
    })
    if (!view) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }

    const reply = deps.pairing.getHandshakeReply(pairingId)
    if (!reply) {
      deps.send({ t: 'rejected', reason: 'expired' })
      return
    }

    active = {
      pairingId,
      deviceId: reply.deviceId,
      devicePublicKey,
      boundJti: pendingBoundJti,
      name: parsed.proposedName ?? null,
    }

    deps.send({
      t: 'pair-ack',
      daemonPublicKey: toBase64Url(reply.daemonPublicKey),
      daemonId: reply.daemonId,
      deviceId: reply.deviceId,
      protocolVersion: reply.protocolVersion,
    })
  }

  const confirm = async (
    pairingId: string,
    name?: string
  ): Promise<ReturnType<RemotePairing['confirmPairing']>> => {
    // Atomicity (issue: confirm wasn't atomic). The OLD order wrote the device row + consumed the
    // pending FIRST, then checked boundJti/token and POSTed the gateway — so a missing boundJti, a
    // logged-out daemon, or a failed gateway POST left a GHOST local device + a dead (consumed) pairing
    // code, while the desktop reported failure. The device list changed under a "failed" confirm.
    //
    // New order: every pre-write check + the gateway row come FIRST; the local trust-root write happens
    // ONLY after the gateway succeeds. Any pre-write failure leaves the pending pairing fully intact —
    // the desktop can retry, the phone can rescan, nothing half-finished is persisted.

    // Non-consuming gone/expired check: keep the null-return contract for a pairing that's no longer
    // confirmable (so the route still answers "not found" instead of throwing).
    if (!deps.pairing.getPending(pairingId)) return null

    // The active handshake carries the devicePublicKey + boundJti (D2) the gateway row is keyed by.
    if (active?.pairingId !== pairingId || !active.boundJti || !active.devicePublicKey) {
      throw new Error('pairing confirm: missing boundJti for gateway registration')
    }
    const gatewayUrl = deps.getGatewayUrl()
    const daemonToken = deps.getDaemonToken()
    if (!gatewayUrl || !daemonToken) {
      throw new Error('pairing confirm: remote not logged in')
    }
    // Resolve the name the SAME way the engine's confirmPairing will (operator override → phone's
    // proposedName → default) so the gateway row and the local row agree on it.
    const deviceName = name ?? active.name ?? 'New device'

    // Gateway row FIRST. If this throws, NOTHING local changed — the pending pairing is still alive.
    await deps.postPairConfirm(
      { gatewayUrl, daemonToken },
      {
        deviceId: active.deviceId,
        devicePubkey: toBase64Url(active.devicePublicKey),
        name: deviceName,
        boundJti: active.boundJti,
      }
    )

    // Trust-root local write happens ONLY now (gateway row exists → the phone's later /pair/session
    // finds it, no 403 race). confirmPairing consumes the pending.
    const record = deps.pairing.confirmPairing(pairingId, name === undefined ? undefined : { name })
    if (!record) return null // vanished in the tiny window since the POST (expired) — nothing to relay

    deps.send({ t: 'confirmed', deviceId: record.id })
    active = null
    pendingBoundJti = null
    return record
  }

  return { onPeerOnline, onPairingFrame, confirm }
}
