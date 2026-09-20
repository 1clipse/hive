import { realpathSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'

export const realpathNative = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSYS') return realpathSync(path)
    throw error
  }
}

export const normalizeFilesystemIdentity = (
  path: string,
  platform: NodeJS.Platform = process.platform
): string => {
  const resolveForPlatform = platform === 'win32' ? win32.resolve : posix.resolve
  let resolved: string
  if (platform === process.platform) {
    try {
      resolved = realpathNative(path)
    } catch {
      resolved = resolve(path)
    }
  } else {
    resolved = resolveForPlatform(path)
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const sameFilesystemPath = (
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean =>
  normalizeFilesystemIdentity(left, platform) === normalizeFilesystemIdentity(right, platform)
