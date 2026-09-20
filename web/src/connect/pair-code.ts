import {
  encodePairingPayload,
  REMOTE_CRYPTO_VERSION,
  toBase64Url,
} from '../../../src/shared/remote-crypto.js'
import {
  normalizePairingCode,
  PAIRING_CODE_SECRET_CONTEXT,
} from '../../../src/shared/remote-pairing-code.js'

const encoder = new TextEncoder()

const gatewayOrigin = (raw: string): string => new URL(raw).origin

export const buildPairingPayloadFromCode = async (input: {
  code: string
  daemonId: string
  gatewayUrl: string
}): Promise<string | null> => {
  const normalized = normalizePairingCode(input.code)
  if (!normalized) return null
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${PAIRING_CODE_SECRET_CONTEXT}${normalized}`)
  )
  return encodePairingPayload({
    v: REMOTE_CRYPTO_VERSION,
    gatewayUrl: gatewayOrigin(input.gatewayUrl),
    daemonId: input.daemonId,
    pairingSecret: toBase64Url(new Uint8Array(digest)),
  })
}
