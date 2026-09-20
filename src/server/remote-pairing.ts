import { createHash, randomUUID } from 'node:crypto'

import { randomBytes } from '@noble/ciphers/utils.js'

import {
  type DeviceKeyPair,
  deriveDaemonSession,
  encodePairingPayload,
  generateDeviceKeyPair,
  type HandshakeIds,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  SESSION_SALT_LEN,
  toBase64Url,
  X25519_KEY_LEN,
} from '../shared/remote-crypto.js'
import {
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  PAIRING_CODE_SECRET_CONTEXT,
} from '../shared/remote-pairing-code.js'
import type { RemoteAuditStore } from './remote-audit-store.js'
import type { RemoteDeviceRecord, RemoteDeviceStore } from './remote-device-store.js'

// Daemon-side device-pairing engine (M4 trust root). It mints a short-TTL one-time pairing token +
// QR, runs the DAEMON half of the M1 X25519 handshake against the phone's transmitted public key,
// computes the 6-digit SAS the desktop shows beside the phone's, and holds the result in memory in an
// `awaiting_confirm` state. NOTHING is persisted until a human confirms at the desktop — that route is
// the Authority Model trust root, and `confirmPairing` is the ONLY caller of `deviceStore.insert`.
//
// Everything before confirm (pairingSecret, ephemeral daemon keypair, derived session keys, SAS) lives
// ONLY in the in-memory pending map and is wiped the instant the pairing reaches a terminal state
// (confirmed / rejected / expired). It is never written to SQLite, never returned to a route, and
// never logged (invariant 7).
//
// Pairing transport is OPTION B: in M4 the phone is driven in-process by the test fixtures (and, in
// M5, by the gateway pairing socket) calling submitDeviceHello/getHandshakeReply/confirmPairing
// directly. There is NO new frame class on the M3 bridge — an unpaired phone has no session in the
// provider, so it physically cannot open a relay stream (invariant 4) until after a confirm.

export type PairingState =
  | 'awaiting_handshake' // token minted + QR shown; the phone has not sent its pubkey yet
  | 'awaiting_confirm' // handshake done, SAS computed; the DESKTOP human must confirm
  | 'confirmed' // persisted; terminal
  | 'rejected' // user rejected, token replayed, or forged-confirm — terminal
  | 'expired' // TTL elapsed pre-confirm — terminal

// Short TTL: a leaked pairing code is useless within five minutes (invariant 2), while real
// phone/OAuth/manual-entry paths have enough time to complete without racing the clock.
export const PAIRING_TTL_MS = 5 * 60_000

// Reject reasons map onto the closed RemoteAuditAction 'reject' category (no new enum members).
export type PairingRejectReason =
  | 'pairing_expired'
  | 'pairing_replay'
  | 'pairing_unknown'
  | 'pairing_bad_input'
  | 'pairing_confirm_forbidden'

// What beginPairing hands the desktop. `code` is the human-entered pairing secret; `qr` remains a
// compatibility deeplink carrier for tests/older scan flows and contains the same derived secret.
export interface PairingTicket {
  pairingId: string // internal handle — NOT the secret
  qr: string // encodePairingPayload(...) — only the M1 PairingPayload fields
  code: string // XXXX-XXXX-XXXX, shown to the desktop user
  expiresAt: number
}

// What the confirm dialog / Settings poll sees. NO key material, NO secret. The route serialises this
// verbatim, so its shape is part of invariant 7's secret-surface boundary.
export interface PendingPairingView {
  pairingId: string
  deviceName: string | null // phone-proposed; the operator may override on confirm
  sas: string // 6-digit, shown beside the phone's SAS
  expiresAt: number
}

// Public material the transport needs to build the phone's PairAck so it can run deriveDeviceSession.
// daemonPublicKey is a PUBLIC key — safe to emit. This is the ONLY surface that returns the daemon
// pubkey; it is deliberately separate from PendingPairingView (which a route serialises) so the route
// cannot accidentally leak it into an HTTP body.
export interface HandshakeReply {
  daemonPublicKey: Uint8Array // 32
  daemonId: string
  deviceId: string
  protocolVersion: number
}

// Phone handshake inputs (over the M5 pairing transport; in-process in M4). Possession of the pairing
// secret is proven implicitly: a wrong secret derives different keys -> a different SAS -> the human
// won't confirm (invariant 3). No separate MAC is needed.
export interface DevicePairingHello {
  pairingId: string
  devicePublicKey: Uint8Array // 32
  sessionSalt: Uint8Array // 32 — the phone draws it fresh
  proposedName?: string
}

export interface RemotePairingDeps {
  deviceStore: RemoteDeviceStore
  audit: RemoteAuditStore
  getGatewayUrl: () => string | null // from remote_gateway_url app_state
  getDaemonId: () => string | null // from remote_daemon_id app_state
  // seams (defaulted in production; injected by tests)
  now?: () => number
  ttlMs?: number
  newDaemonKeyPair?: () => DeviceKeyPair // ephemeral per handshake
  randomPairingSecret?: () => Uint8Array
  randomPairingCode?: () => string
  newId?: () => string // pairingId + deviceId
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (h: NodeJS.Timeout) => void
}

export interface RemotePairing {
  beginPairing(): PairingTicket // desktop "Add device"
  submitDeviceHello(hello: DevicePairingHello): PendingPairingView | null // phone handshake
  getHandshakeReply(pairingId: string): HandshakeReply | null // public PairAck for the transport
  confirmPairing(pairingId: string, opts?: { name?: string }): RemoteDeviceRecord | null // TRUST ROOT
  rejectPairing(pairingId: string, reason?: string): void
  getPending(pairingId: string): PendingPairingView | null
  listPending(): PendingPairingView[]
  // The single awaiting_handshake pairing's id (the desktop minted it via beginPairing; no hello yet),
  // or null. The pairing-over-tunnel driver needs it to bind an inbound phone hello (D1: at most one
  // awaiting_handshake pairing per daemon, since the relay permits a single pair socket). Returns only
  // the pairingId HANDLE — no secret, no key material (same surface class as listPending's ids).
  findAwaitingHandshake(): string | null
  dispose(): void
}

interface PendingPairing {
  pairingId: string
  deviceId: string // pre-allocated; only becomes a real row on confirm
  state: PairingState
  expiresAt: number
  pairingSecret: Uint8Array
  daemonKeyPair: DeviceKeyPair
  // populated after a successful hello (awaiting_confirm):
  sessionKeys: { d2p: Uint8Array; p2d: Uint8Array } | null
  devicePublicKey: Uint8Array | null
  sas: string | null
  proposedName: string | null
  timer: NodeJS.Timeout | null
}

const defaultName = (): string => 'New device'

const pairingSecretFromCode = (code: string): Uint8Array => {
  const normalized = normalizePairingCode(code)
  if (!normalized) throw new RangeError('invalid pairing code')
  return new Uint8Array(
    createHash('sha256').update(PAIRING_CODE_SECRET_CONTEXT).update(normalized).digest()
  )
}

const toView = (p: PendingPairing): PendingPairingView => ({
  pairingId: p.pairingId,
  deviceName: p.proposedName,
  sas: p.sas ?? '',
  expiresAt: p.expiresAt,
})

export const createRemotePairing = (deps: RemotePairingDeps): RemotePairing => {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? PAIRING_TTL_MS
  const newDaemonKeyPair = deps.newDaemonKeyPair ?? generateDeviceKeyPair
  const randomPairingSecret = deps.randomPairingSecret
  const randomPairingCode =
    deps.randomPairingCode ?? (() => generatePairingCode((length) => randomBytes(length)))
  const newId = deps.newId ?? randomUUID
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

  const pending = new Map<string, PendingPairing>()

  // Zero the in-memory secrets the moment a pairing leaves a pre-terminal state. The key bytes are
  // owned by us (never aliased into the store except via a copy on insert), so wiping them here is
  // belt-and-suspenders against a heap dump.
  const wipe = (p: PendingPairing): void => {
    p.pairingSecret.fill(0)
    p.daemonKeyPair.secretKey.fill(0)
    if (p.sessionKeys) {
      p.sessionKeys.d2p.fill(0)
      p.sessionKeys.p2d.fill(0)
    }
    if (p.timer !== null) {
      clearTimer(p.timer)
      p.timer = null
    }
  }

  const auditReject = (
    reason: PairingRejectReason | string,
    deviceId: string | null = null
  ): void => {
    deps.audit.enqueue({ action: 'reject', result: 'rejected', rejectReason: reason, deviceId })
  }

  // Drop a pending pairing, wipe its secrets, mark terminal. Used by reject + expire + confirm.
  const discard = (pairingId: string, state: PairingState): PendingPairing | null => {
    const p = pending.get(pairingId)
    if (!p) return null
    p.state = state
    wipe(p)
    pending.delete(pairingId)
    return p
  }

  const expire = (pairingId: string): void => {
    const p = pending.get(pairingId)
    if (!p) return
    discard(pairingId, 'expired')
    auditReject('pairing_expired', p.deviceId)
  }

  // Lazy expiry on every access: TTL is enforced even if the timer never fired (and unit tests never
  // rely on a real setTimeout). A pairing whose deadline passed is treated as gone.
  const sweep = (): void => {
    const t = now()
    for (const [id, p] of [...pending]) {
      if (t >= p.expiresAt) expire(id)
    }
  }

  return {
    beginPairing(): PairingTicket {
      const gatewayUrl = deps.getGatewayUrl()
      const daemonId = deps.getDaemonId()
      if (!gatewayUrl || !daemonId) {
        throw new Error('remote not logged in: cannot start pairing')
      }

      const code = randomPairingCode()
      const pairingSecret = randomPairingSecret?.() ?? pairingSecretFromCode(code)
      if (pairingSecret.length !== PAIRING_SECRET_LEN) {
        throw new RangeError(`pairing secret must be ${PAIRING_SECRET_LEN} bytes`)
      }
      const daemonKeyPair = newDaemonKeyPair()
      const pairingId = newId()
      const deviceId = newId()
      const expiresAt = now() + ttlMs

      const entry: PendingPairing = {
        pairingId,
        deviceId,
        state: 'awaiting_handshake',
        expiresAt,
        pairingSecret,
        daemonKeyPair,
        sessionKeys: null,
        devicePublicKey: null,
        sas: null,
        proposedName: null,
        timer: null,
      }
      entry.timer = setTimer(() => expire(pairingId), ttlMs)
      pending.set(pairingId, entry)

      const qr = encodePairingPayload({
        v: REMOTE_CRYPTO_VERSION,
        gatewayUrl,
        daemonId,
        pairingSecret: toBase64Url(pairingSecret),
      })
      return { pairingId, qr, code: formatPairingCode(code), expiresAt }
    },

    submitDeviceHello(hello: DevicePairingHello): PendingPairingView | null {
      sweep()
      const p = pending.get(hello.pairingId)
      if (!p) {
        // Unknown OR already consumed (a replay deletes/advances the entry).
        auditReject('pairing_unknown')
        return null
      }
      if (p.state !== 'awaiting_handshake') {
        // One-time: a second hello on a token that already produced a pending is a replay.
        auditReject('pairing_replay', p.deviceId)
        return null
      }
      if (now() >= p.expiresAt) {
        expire(hello.pairingId)
        return null
      }
      if (
        hello.devicePublicKey.length !== X25519_KEY_LEN ||
        hello.sessionSalt.length !== SESSION_SALT_LEN
      ) {
        discard(hello.pairingId, 'rejected')
        auditReject('pairing_bad_input', p.deviceId)
        return null
      }

      const daemonId = deps.getDaemonId()
      if (!daemonId) {
        // Logged out between begin and hello — treat as unusable, drop the pairing.
        discard(hello.pairingId, 'rejected')
        auditReject('pairing_unknown', p.deviceId)
        return null
      }

      const ids: HandshakeIds = {
        daemonId,
        deviceId: p.deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      }
      const keys = deriveDaemonSession({
        daemonSecretKey: p.daemonKeyPair.secretKey,
        devicePublicKey: hello.devicePublicKey,
        daemonPublicKey: p.daemonKeyPair.publicKey,
        pairingSecret: p.pairingSecret,
        sessionSalt: hello.sessionSalt,
        ids,
      })

      p.sessionKeys = { d2p: keys.d2p, p2d: keys.p2d }
      p.sas = keys.sas
      p.devicePublicKey = hello.devicePublicKey
      p.proposedName = hello.proposedName ?? null
      p.state = 'awaiting_confirm'
      // Still NOT persisted, NOT in the provider — a relay attempt now gets provider.get === null.
      return toView(p)
    },

    getHandshakeReply(pairingId: string): HandshakeReply | null {
      sweep()
      const p = pending.get(pairingId)
      if (!p || p.state !== 'awaiting_confirm') return null
      const daemonId = deps.getDaemonId()
      if (!daemonId) return null
      // daemonPublicKey is PUBLIC — fine to emit so the phone can run deriveDeviceSession.
      return {
        daemonPublicKey: p.daemonKeyPair.publicKey,
        daemonId,
        deviceId: p.deviceId,
        protocolVersion: REMOTE_CRYPTO_VERSION,
      }
    },

    // THE trust root. The route layer guarantees this only runs for a local desktop request.
    confirmPairing(pairingId: string, opts?: { name?: string }): RemoteDeviceRecord | null {
      sweep()
      const p = pending.get(pairingId)
      if (!p || p.state !== 'awaiting_confirm' || !p.sessionKeys || !p.devicePublicKey) {
        return null
      }

      const rec = deps.deviceStore.insert({
        id: p.deviceId,
        name: opts?.name ?? p.proposedName ?? defaultName(),
        keys: { d2p: p.sessionKeys.d2p, p2d: p.sessionKeys.p2d },
        devicePublicKey: p.devicePublicKey,
      })
      deps.audit.enqueue({ action: 'session_open', deviceId: rec.id, result: 'ok' })

      // The store INSERT copied the key bytes via toBase64Url, so wiping our in-memory copy is safe.
      discard(pairingId, 'confirmed')
      return rec
    },

    rejectPairing(pairingId: string, reason?: string): void {
      sweep()
      const p = pending.get(pairingId)
      if (!p) return
      discard(pairingId, 'rejected')
      auditReject(reason ?? 'pairing_replay', p.deviceId)
    },

    getPending(pairingId: string): PendingPairingView | null {
      sweep()
      const p = pending.get(pairingId)
      if (!p || p.state !== 'awaiting_confirm') return null
      return toView(p)
    },

    listPending(): PendingPairingView[] {
      sweep()
      return [...pending.values()].filter((p) => p.state === 'awaiting_confirm').map(toView)
    },

    findAwaitingHandshake(): string | null {
      sweep()
      // At most one in practice (D1). If two ever coexist, take the freshest (latest deadline) so a
      // re-minted token wins over a stale one the user abandoned.
      let best: PendingPairing | null = null
      for (const p of pending.values()) {
        if (p.state !== 'awaiting_handshake') continue
        if (!best || p.expiresAt > best.expiresAt) best = p
      }
      return best?.pairingId ?? null
    },

    dispose(): void {
      for (const id of [...pending.keys()]) {
        discard(id, 'rejected')
      }
    },
  }
}
