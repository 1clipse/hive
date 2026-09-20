import { homedir } from 'node:os'
import { join } from 'node:path'

const toForwardSlashes = (path: string) => path.replace(/\\/g, '/')

const normalizeForWin32 = (path: string) => toForwardSlashes(path).toLowerCase()

export const expandHomePath = (path: string): string => {
  if (path === '~') return homedir()
  const match = /^~[\\/](.*)$/u.exec(path)
  if (!match) return path
  const rest = match[1] ?? ''
  if (!rest) return homedir()
  return join(homedir(), ...rest.split(/[\\/]+/u).filter(Boolean))
}

export const arePathsEqual = (
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean => {
  if (platform === 'win32') return normalizeForWin32(left) === normalizeForWin32(right)
  return left === right
}

export const containsPathMarker = (
  haystack: string,
  marker: string,
  platform: NodeJS.Platform = process.platform
): boolean => indexOfPathMarker(haystack, marker, platform) !== -1

export const indexOfPathMarker = (
  haystack: string,
  marker: string,
  platform: NodeJS.Platform = process.platform
): number => {
  if (platform === 'win32') return normalizeForWin32(haystack).indexOf(normalizeForWin32(marker))
  return haystack.indexOf(marker)
}
