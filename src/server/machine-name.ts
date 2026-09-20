import { hostname } from 'node:os'

const MAX_LEN = 64

// Trim surrounding whitespace, strip a trailing '.local' suffix (common on macOS),
// and cap at 64 chars. Returns null if the result is empty.
export function cleanMachineName(raw: string): string | null {
  const cleaned = raw.trim().replace(/\.local$/i, '')
  if (cleaned.length === 0) return null
  return cleaned.slice(0, MAX_LEN)
}

export function getMachineName(): string | null {
  return cleanMachineName(hostname())
}
