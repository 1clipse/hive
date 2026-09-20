// Quarantined browser-safety guard: this test mutates globalThis.Buffer to prove the crypto core
// has no Buffer dependency. vitest.config.ts runs files in a single non-parallel worker, so this
// global mutation lives in its own module to keep it from contaminating the adversarial tamper/
// replay/downgrade assertions in remote-crypto.test.ts (a flake source if the two share a worker).
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, test } from 'vitest'
import {
  deriveDaemonSession,
  deriveDeviceSession,
  fromBase64Url,
  generateDeviceKeyPair,
  type HandshakeIds,
  openFrame,
  PAIRING_SECRET_LEN,
  REMOTE_CRYPTO_VERSION,
  sealFrame,
  serializeDeviceKeyPair,
  toBase64Url,
} from '../../src/shared/remote-crypto.js'

const IDS: HandshakeIds = {
  daemonId: 'daemon-A',
  deviceId: 'device-1',
  protocolVersion: REMOTE_CRYPTO_VERSION,
}

function fixedHeader(streamId: number, seq: number, kind = 0x02): Uint8Array {
  const h = new Uint8Array(12)
  const dv = new DataView(h.buffer)
  dv.setUint8(0, REMOTE_CRYPTO_VERSION)
  dv.setUint8(1, kind)
  dv.setUint16(2, 0)
  dv.setUint32(4, streamId)
  dv.setUint32(8, seq)
  return h
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function handshake() {
  const pairingSecret = new Uint8Array(PAIRING_SECRET_LEN).fill(9)
  const sessionSalt = new Uint8Array(32).fill(5)
  const daemonSk = x25519.utils.randomSecretKey()
  const deviceSk = x25519.utils.randomSecretKey()
  const daemonPk = x25519.getPublicKey(daemonSk)
  const devicePk = x25519.getPublicKey(deviceSk)
  const daemon = deriveDaemonSession({
    daemonSecretKey: daemonSk,
    devicePublicKey: devicePk,
    daemonPublicKey: daemonPk,
    pairingSecret,
    sessionSalt,
    ids: IDS,
  })
  const device = deriveDeviceSession({
    deviceSecretKey: deviceSk,
    daemonPublicKey: daemonPk,
    devicePublicKey: devicePk,
    pairingSecret,
    sessionSalt,
    ids: IDS,
  })
  return { daemon, device }
}

describe('no Buffer dependency (browser-safe)', () => {
  test('seal/open + serialize work with globalThis.Buffer removed', () => {
    const original = (globalThis as { Buffer?: unknown }).Buffer
    try {
      ;(globalThis as { Buffer?: unknown }).Buffer = undefined
      const { daemon, device } = handshake()
      const header = fixedHeader(1, 0)
      const payload = new Uint8Array([1, 2, 3, 4])
      const ct = sealFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: header, payload })
      const pt = openFrame({
        key: device.d2p,
        direction: 'd2p',
        headerBytes: header,
        ciphertext: ct,
      })
      expect(ct).toBeInstanceOf(Uint8Array)
      expect(pt).toBeInstanceOf(Uint8Array)
      expect(bytesEqual(pt, payload)).toBe(true)

      const kp = generateDeviceKeyPair()
      const ser = serializeDeviceKeyPair(kp)
      expect(typeof ser.secretKey).toBe('string')
      const b64 = toBase64Url(payload)
      expect(fromBase64Url(b64)).toBeInstanceOf(Uint8Array)
    } finally {
      ;(globalThis as { Buffer?: unknown }).Buffer = original
    }
  })

  test('tampered AAD still rejects with Buffer removed (the guard does not weaken auth)', () => {
    const original = (globalThis as { Buffer?: unknown }).Buffer
    try {
      ;(globalThis as { Buffer?: unknown }).Buffer = undefined
      const { daemon } = handshake()
      const header = fixedHeader(1, 0)
      const ct = sealFrame({
        key: daemon.d2p,
        direction: 'd2p',
        headerBytes: header,
        payload: new Uint8Array([1, 2, 3]),
      })
      const tampered = Uint8Array.from(header)
      tampered[1] = (tampered[1] ?? 0) ^ 0x01
      expect(() =>
        openFrame({ key: daemon.d2p, direction: 'd2p', headerBytes: tampered, ciphertext: ct })
      ).toThrow(/invalid tag/)
    } finally {
      ;(globalThis as { Buffer?: unknown }).Buffer = original
    }
  })
})
