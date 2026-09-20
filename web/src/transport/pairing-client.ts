// Phone-side pairing client (transport-level). Mirrors the daemon's createPairingCeremony 1:1, but the
// in-process method calls become frames over the gateway pairing channel (/relay/pair). It:
//   1. decodes the QR (decodePairingPayload),
//   2. generates the device keypair + a fresh session salt,
//   3. opens the pairing socket, sends a phase-(i) CLEARTEXT Hello envelope (public material only:
//      device pubkey, salt, proposedName, the phone's gateway-session jti) — the bootstrap (SEAM 4),
//   4. on the phase-(i) PairAck (daemon PUBLIC key + ids), runs deriveDeviceSession over the daemon's
//      TRANSMITTED pubkey (NEVER copies the daemon's keys) and surfaces the 6-digit SAS for the human,
//   5. awaits the daemon's `confirmed` signal, then calls /pair/session to obtain the device-bound
//      gateway session (the gateway re-checks the device row — THAT is the authority, not `confirmed`),
//   6. persists ONLY the durable identity (keypair + daemon public key + ids) and wipes plaintext.
//
// Security spine:
//   - invariant 2: the `confirmed` frame is just a UI hint; the binding authority is the gateway's
//     /pair/session re-check of the desktop-created device row. A faked confirm → mintSession 403 →
//     mint_forbidden → NOTHING persisted. The phone cannot self-promote.
//   - invariant 4: keys are DERIVED locally over the relayed daemon pubkey. A MITM swap → a different
//     SAS (the human refuses) AND directional keys the daemon can't open. The phone never trusts a
//     key it didn't derive itself.
//   - invariant 3 (M6.1 relaxation): the persisted record carries no pairingSecret and no UI token. It
//     DOES persist the directional ROOT keys (rootKeys) — the phone cannot re-derive the root on reload
//     (pairingSecret + sessionSalt are one-time and wiped here), so it must persist it, mirroring the
//     daemon's SQLite row. The root is never an AEAD key: per-connection AEAD keys are derived fresh
//     from it + a bilateral connection salt on every connect, so caching ephemeral connKeys is still
//     forbidden. The persisted rootKeys are copied to base64url BEFORE wipe() zeroes the live bytes.

import { HB_PING, HB_PONG } from '../../../src/server/remote-control-constants.js'
import {
  type DeviceKeyPair,
  decodePairingPayload,
  deriveDeviceSession,
  fromBase64Url,
  generateDeviceKeyPair,
  generateSessionSalt,
  type HandshakeIds,
  REMOTE_CRYPTO_VERSION,
  type SessionKeys,
  serializeDeviceKeyPair,
  toBase64Url,
} from '../../../src/shared/remote-crypto.js'
import type { DeviceSessionStore, StoredDeviceSession } from './device-session-store.js'

export type PairingPhase =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'awaiting_confirm'
  | 'minting'
  | 'paired'
  | 'rejected'
  | 'expired'
  | 'error'

export type PairingFailureCode =
  | 'rejected'
  | 'expired'
  | 'socket_closed'
  | 'pair_ack_invalid'
  | 'mint_forbidden'
  | 'mint_failed'
  | 'protocol_version'
  | 'cancelled'

export interface PairingFailure {
  code: PairingFailureCode
  message: string
}

export interface PairingClientEvents {
  onPhase(phase: PairingPhase): void
  /** Fired once on awaiting_confirm with the 6-digit SAS the human compares against the desktop. */
  onSas(sas: string): void
  onFailure(failure: PairingFailure): void
}

// The subset of the DOM WebSocket the pairing client uses. The gateway pairing socket structurally
// satisfies this; tests hand-roll it.
export interface WebSocketLike {
  send(data: string | ArrayBufferLike): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: unknown) => void): void
}

export interface PairingClientDeps {
  /** Open the gateway pairing socket. Browser path uses same-origin cookie auth on /relay/pair. */
  openSocket: (url: string, protocols?: string[]) => WebSocketLike
  store: DeviceSessionStore
  /** Default: POST /pair/session. Resolves on 200, REJECTS (with .status) on 4xx. */
  mintSession: (gatewayUrl: string, body: { daemonId: string; deviceId: string }) => Promise<void>
  generateKeyPair?: () => DeviceKeyPair
  generateSalt?: () => Uint8Array
  proposedName?: string
  /** The phone's unpaired gateway-session jti, bound into the pairing to close a concurrent race. */
  boundJti?: string
  now?: () => number
  /** ms between pairing-socket heartbeats while the human is confirming SAS. */
  heartbeatMs?: number
  /** ms to wait for hb:pong before failing the one-shot pairing ceremony. */
  heartbeatDeadlineMs?: number
}

export type PairingResult = { ok: true; deviceId: string } | { ok: false; failure: PairingFailure }

export interface PairingClient {
  readonly phase: PairingPhase
  readonly sas: string | null
  readonly deviceId: string | null
  start(): Promise<PairingResult>
  cancel(): void
  dispose(): void
}

const pairingSocketUrl = (gatewayUrl: string, daemonId: string): string => {
  const u = new URL(gatewayUrl)
  if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol === 'http:') u.protocol = 'ws:'
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
    throw new Error(`unsupported pairing gateway protocol: ${u.protocol}`)
  }
  const base = u.toString().replace(/\/+$/, '')
  return `${base}/relay/pair?daemonId=${encodeURIComponent(daemonId)}`
}

// Phase-(i) envelopes (cleartext public material; gateway forwards verbatim, opaque). Mirrors what the
// daemon pairing shim parses and what createPairingCeremony exchanges in-process.
interface HelloEnvelope {
  t: 'hello'
  devicePublicKey: string
  sessionSalt: string
  proposedName?: string
  boundJti?: string
}
interface PairAckEnvelope {
  t: 'pair-ack'
  daemonPublicKey: string
  daemonId: string
  deviceId: string
  protocolVersion: number
}
interface ConfirmedEnvelope {
  t: 'confirmed'
  deviceId: string
}
interface RejectedEnvelope {
  t: 'rejected'
  reason?: string
}

type InboundEnvelope = PairAckEnvelope | ConfirmedEnvelope | RejectedEnvelope | { t: string }

const isInbound = (raw: unknown): raw is InboundEnvelope =>
  typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).t === 'string'

const DEFAULT_HEARTBEAT_MS = 20_000
const DEFAULT_HEARTBEAT_DEADLINE_MS = 10_000

export function createPairingClient(
  qrPayload: string,
  events: PairingClientEvents,
  deps: PairingClientDeps
): PairingClient {
  const generateKeyPair = deps.generateKeyPair ?? generateDeviceKeyPair
  const generateSalt = deps.generateSalt ?? generateSessionSalt
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const heartbeatDeadlineMs = deps.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS

  let phase: PairingPhase = 'idle'
  let sas: string | null = null
  let deviceId: string | null = null
  let socket: WebSocketLike | null = null
  let settled = false
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  // Key material held only for the duration of the ceremony.
  let keyPair: DeviceKeyPair | null = null
  let salt: Uint8Array | null = null
  let sessionKeys: SessionKeys | null = null
  let daemonPublicKeyB64: string | null = null
  let gatewayUrl = ''
  let daemonId = ''

  let resolve: ((r: PairingResult) => void) | null = null

  const setPhase = (next: PairingPhase): void => {
    phase = next
    events.onPhase(next)
  }

  const clearPongDeadline = (): void => {
    if (pongDeadlineTimer === null) return
    clearTimeout(pongDeadlineTimer)
    pongDeadlineTimer = null
  }

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    clearPongDeadline()
  }

  const startHeartbeat = (s: WebSocketLike): void => {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (settled) return
      try {
        s.send(HB_PING)
      } catch {
        // A dying socket will surface through close/error or the deadline below.
      }
      // Track the oldest unanswered ping, matching the device relay socket. Resetting the deadline on
      // every ping would hide a half-open mobile connection forever.
      if (pongDeadlineTimer === null) {
        pongDeadlineTimer = setTimeout(() => {
          pongDeadlineTimer = null
          if (settled) return
          try {
            s.close()
          } catch {
            // best-effort
          }
          // Half-open socket. Past the SAS this still tries the mint (the desktop may have confirmed);
          // before it, it's a socket_closed. (Routed through onSocketDown, same as a close event.)
          onSocketDown()
        }, heartbeatDeadlineMs)
      }
    }, heartbeatMs)
  }

  // Wipe every plaintext secret. Called on EVERY terminal except the bytes we deliberately persist
  // (the keypair, persisted via serializeDeviceKeyPair BEFORE this runs).
  const wipe = (): void => {
    keyPair?.secretKey.fill(0)
    salt?.fill(0)
    if (sessionKeys) {
      sessionKeys.d2p.fill(0)
      sessionKeys.p2d.fill(0)
      sessionKeys.transcriptHash.fill(0)
    }
    keyPair = null
    salt = null
    sessionKeys = null
  }

  const finish = (result: PairingResult): void => {
    if (settled) return
    settled = true
    stopHeartbeat()
    wipe()
    try {
      socket?.close()
    } catch {
      // best-effort
    }
    socket = null
    resolve?.(result)
  }

  const fail = (code: PairingFailureCode, message: string): void => {
    if (settled) return
    const failure: PairingFailure = { code, message }
    // Map the failure onto a sticky terminal phase for the UI.
    if (code === 'rejected') setPhase('rejected')
    else if (code === 'expired') setPhase('expired')
    else setPhase('error')
    events.onFailure(failure)
    finish({ ok: false, failure })
  }

  const onPairAck = (env: PairAckEnvelope): void => {
    if (phase !== 'connecting' && phase !== 'handshaking') return
    if (env.protocolVersion !== REMOTE_CRYPTO_VERSION) {
      fail('protocol_version', `unsupported pairing protocol version ${env.protocolVersion}`)
      return
    }
    if (!keyPair || !salt) {
      fail('pair_ack_invalid', 'pair-ack arrived before the phone keypair was ready')
      return
    }
    let daemonPub: Uint8Array
    try {
      daemonPub = fromBase64Url(env.daemonPublicKey)
    } catch {
      fail('pair_ack_invalid', 'pair-ack daemonPublicKey is not valid base64url')
      return
    }
    const ids: HandshakeIds = {
      daemonId: env.daemonId,
      deviceId: env.deviceId,
      protocolVersion: env.protocolVersion,
    }
    try {
      // Derive over the daemon's TRANSMITTED pubkey. A MITM swap diverges the SAS + the directional
      // keys — we never copy the daemon's session (invariant 4).
      sessionKeys = deriveDeviceSession({
        deviceSecretKey: keyPair.secretKey,
        daemonPublicKey: daemonPub,
        devicePublicKey: keyPair.publicKey,
        pairingSecret: pairingSecret,
        sessionSalt: salt,
        ids,
      })
    } catch (err) {
      fail('pair_ack_invalid', `handshake derivation failed: ${(err as Error).message}`)
      return
    }
    deviceId = env.deviceId
    daemonId = env.daemonId
    daemonPublicKeyB64 = env.daemonPublicKey
    sas = sessionKeys.sas
    setPhase('awaiting_confirm')
    events.onSas(sas)
  }

  // Mint the device-bound session via /pair/session — the AUTHORITY (invariant 2: a faked confirm 403s
  // here, nothing persists). Shared by onConfirmed (happy path) AND the socket-down recovery below: if
  // the desktop confirmed but the `confirmed` frame was lost on a flaky mobile link, the mint still
  // succeeds because the gateway device row already exists.
  const runMint = (): void => {
    if (settled) return
    if (!sessionKeys || !keyPair || !deviceId) {
      fail('pair_ack_invalid', 'cannot mint before the handshake produced a session')
      return
    }
    setPhase('minting')
    deps
      .mintSession(gatewayUrl, { daemonId, deviceId })
      .then(() => {
        if (settled || !keyPair || !daemonPublicKeyB64 || !deviceId || !sessionKeys) return
        // Persist the durable identity + the directional ROOT (rootKeys), copied to base64url BEFORE
        // wipe() zeroes the live bytes. The phone can't re-derive the root on reload (the pairingSecret
        // + salt are one-time and wiped), so it persists it like the daemon does — never an AEAD key
        // directly (invariant 3, M6.1).
        const rec: StoredDeviceSession = {
          v: 2,
          gatewayUrl,
          daemonId,
          deviceId,
          deviceKeyPair: serializeDeviceKeyPair(keyPair),
          daemonPublicKey: daemonPublicKeyB64,
          rootKeys: { d2p: toBase64Url(sessionKeys.d2p), p2d: toBase64Url(sessionKeys.p2d) },
          protocolVersion: REMOTE_CRYPTO_VERSION,
          pairedAt: (deps.now ?? Date.now)(),
        }
        deps.store.save(rec)
        const id = deviceId
        setPhase('paired')
        finish({ ok: true, deviceId: id })
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number }).status
        if (status === 403) {
          fail('mint_forbidden', 'gateway refused to mint a device session (not confirmed)')
        } else {
          fail('mint_failed', `device session mint failed: ${(err as Error).message ?? 'unknown'}`)
        }
      })
  }

  const onConfirmed = (env: ConfirmedEnvelope): void => {
    if (phase !== 'awaiting_confirm') return
    if (!sessionKeys || !keyPair || !deviceId || env.deviceId !== deviceId) {
      fail('pair_ack_invalid', 'confirmed for an unexpected device')
      return
    }
    // The `confirmed` frame is ONLY a UI signal; runMint re-checks the authority (/pair/session).
    runMint()
  }

  // A socket close/error is NOT automatically fatal. Past the SAS the desktop may have already confirmed
  // while the `confirmed` frame was dropped on a flaky mobile link — and the mint runs over HTTP, not
  // this socket — so we try the mint ONCE (success ⇒ it was confirmed; 403 ⇒ it wasn't). A close while a
  // mint is already in flight just lets that mint settle us. Only a close BEFORE the SAS (no session yet)
  // is a real socket_closed.
  const onSocketDown = (): void => {
    if (settled) return
    if (phase === 'awaiting_confirm') {
      runMint()
      return
    }
    if (phase === 'minting') return
    fail('socket_closed', 'pairing socket closed before the device was paired')
  }

  const onMessage = (data: unknown): void => {
    if (settled) return
    if (typeof data !== 'string') return // phase-(ii) sealed frames are not parsed here
    if (data === HB_PONG) {
      clearPongDeadline()
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return
    }
    if (!isInbound(raw)) return
    if (phase === 'connecting' && raw.t === 'pair-ack') setPhase('handshaking')
    switch (raw.t) {
      case 'pair-ack':
        onPairAck(raw as PairAckEnvelope)
        break
      case 'confirmed':
        onConfirmed(raw as ConfirmedEnvelope)
        break
      case 'rejected':
        {
          const reason = (raw as RejectedEnvelope).reason
          if (reason === 'expired' || reason === 'pairing_expired') {
            fail('expired', 'pairing code expired; generate a new pairing code')
          } else {
            fail('rejected', reason ?? 'pairing rejected at the desktop')
          }
        }
        break
      default:
        break
    }
  }

  // QR decode up front so a malformed QR fails before any socket opens.
  const payload = decodePairingPayload(qrPayload)
  const pairingSecret = fromBase64Url(payload.pairingSecret)
  gatewayUrl = payload.gatewayUrl
  daemonId = payload.daemonId

  const start = (): Promise<PairingResult> => {
    if (settled) {
      return Promise.resolve({
        ok: false,
        failure: { code: 'cancelled', message: 'already settled' },
      })
    }
    return new Promise<PairingResult>((res) => {
      resolve = res
      keyPair = generateKeyPair()
      salt = generateSalt()
      setPhase('connecting')

      const wsUrl = pairingSocketUrl(payload.gatewayUrl, payload.daemonId)
      try {
        socket = deps.openSocket(wsUrl)
      } catch (err) {
        fail('socket_closed', `failed to open pairing socket: ${(err as Error).message}`)
        return
      }

      socket.addEventListener('open', () => {
        if (settled || !socket || !keyPair || !salt) return
        startHeartbeat(socket)
        const hello: HelloEnvelope = {
          t: 'hello',
          devicePublicKey: toBase64Url(keyPair.publicKey),
          sessionSalt: toBase64Url(salt),
          ...(deps.proposedName ? { proposedName: deps.proposedName } : {}),
          ...(deps.boundJti ? { boundJti: deps.boundJti } : {}),
        }
        socket?.send(JSON.stringify(hello))
      })
      socket.addEventListener('message', (ev) => {
        onMessage((ev as { data?: unknown }).data)
      })
      // Past the SAS, onSocketDown tries the mint (the /pair/session authority) instead of failing —
      // recovering a `confirmed` frame lost on a flaky mobile link. Before the SAS it's socket_closed.
      socket.addEventListener('close', onSocketDown)
      socket.addEventListener('error', onSocketDown)
    })
  }

  return {
    get phase() {
      return phase
    },
    get sas() {
      return sas
    },
    get deviceId() {
      return deviceId
    },
    start,
    cancel: () => {
      if (settled) return
      setPhase('rejected')
      fail('cancelled', 'pairing cancelled')
    },
    dispose: () => {
      if (!settled) finish({ ok: false, failure: { code: 'cancelled', message: 'disposed' } })
      else wipe()
    },
  }
}
