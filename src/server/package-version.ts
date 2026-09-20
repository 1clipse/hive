import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = '@tt-a1i/hive'

/** Updates never need lifecycle scripts; platform binaries are ordinary dependencies. */
export const INSTALL_COMMAND_ARGS = [
  'install',
  '-g',
  `${PACKAGE_NAME}@latest`,
  '--ignore-scripts',
] as const

export const INSTALL_COMMAND_DISPLAY = `npm ${INSTALL_COMMAND_ARGS.join(' ')}`

/**
 * Windows ships npm as `npm.cmd` (a batch shim); Node's `child_process.spawn`
 * will not resolve `.cmd` without `shell: true` or an explicit suffix, so the
 * default `'npm'` produces ENOENT on Windows. Use this helper any time you
 * spawn npm directly.
 */
export const getNpmCommand = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'npm.cmd' : 'npm'

export const readPackageVersion = () => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string') return parsed.version
    }
    dir = dirname(dir)
  }
  return 'unknown'
}
