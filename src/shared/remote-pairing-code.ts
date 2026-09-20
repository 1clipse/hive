export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIRING_CODE_CHARS = 12
export const PAIRING_CODE_RANDOM_BYTES = 8
export const PAIRING_CODE_SECRET_CONTEXT = 'hive-remote-pairing-code-v1:'

export const normalizePairingCode = (input: string): string | null => {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (normalized.length !== PAIRING_CODE_CHARS) return null
  for (const ch of normalized) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return null
  }
  return normalized
}

export const formatPairingCode = (input: string): string => {
  const normalized = normalizePairingCode(input) ?? input.replace(/[\s-]+/g, '').toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < normalized.length; i += 4) {
    groups.push(normalized.slice(i, i + 4))
  }
  return groups.join('-')
}

export const generatePairingCode = (randomBytes: (length: number) => Uint8Array): string => {
  const bytes = randomBytes(PAIRING_CODE_RANDOM_BYTES)
  if (bytes.length < PAIRING_CODE_RANDOM_BYTES) {
    throw new RangeError(`pairing code requires ${PAIRING_CODE_RANDOM_BYTES} random bytes`)
  }

  let acc = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < PAIRING_CODE_CHARS) {
      bits -= 5
      out += PAIRING_CODE_ALPHABET[(acc >> bits) & 31]
    }
    if (out.length === PAIRING_CODE_CHARS) break
  }
  return out
}
