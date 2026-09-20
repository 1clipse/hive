export const WORKER_AVATAR_MAX_CHARS = 160_000

const WORKER_AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

const decodeBase64Bytes = (value: string): Uint8Array => {
  try {
    const binary = globalThis.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    throw new Error('Worker avatar must be valid base64')
  }
}

const hasPrefix = (bytes: Uint8Array, prefix: number[]) =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value)

const matchesImageType = (mediaType: string, bytes: Uint8Array) => {
  if (mediaType === 'png') return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mediaType === 'jpeg') return hasPrefix(bytes, [0xff, 0xd8, 0xff])
  return (
    bytes.length >= 12 &&
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
}

export const normalizeWorkerAvatar = (input: unknown): string | null => {
  if (input === null || input === undefined || input === '') return null
  if (typeof input !== 'string') {
    throw new Error('Worker avatar must be an image data URL or null')
  }
  const value = input.trim()
  if (!value) return null
  if (value.length > WORKER_AVATAR_MAX_CHARS) {
    throw new Error('Worker avatar is too large')
  }
  const match = WORKER_AVATAR_DATA_URL_PATTERN.exec(value)
  if (!match) {
    throw new Error('Worker avatar must be a PNG, JPEG, or WebP data URL')
  }
  const mediaType = match[1]
  const base64Body = match[2]
  if (!mediaType || !base64Body) {
    throw new Error('Worker avatar must be a PNG, JPEG, or WebP data URL')
  }
  const bytes = decodeBase64Bytes(base64Body)
  if (!matchesImageType(mediaType, bytes)) {
    throw new Error('Worker avatar data does not match its image type')
  }
  return value
}
