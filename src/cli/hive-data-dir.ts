import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve the directory where Hive persists its SQLite DB and supporting
 * state. Platform-aware because `~/.config/hive` is a hidden dot-directory
 * convention that Windows Explorer treats as second-class — Windows users
 * can't navigate there from the address bar without typing the full path,
 * and the standard roaming-profile location is `%APPDATA%\<app>` instead.
 *
 * Resolution order:
 *   1. HIVE_DATA_DIR override (any platform, for tests / opinionated users).
 *   2. Windows: %APPDATA%\hive — roaming user state, follows the user
 *      across machines on a domain profile. APPDATA, not LOCALAPPDATA,
 *      because Hive's DB is user data, not a machine-local cache.
 *      Falls back to homedir()\AppData\Roaming\hive when APPDATA is
 *      stripped from the env (some Windows Task Scheduler configs do this).
 *   3. POSIX: $XDG_CONFIG_HOME/hive, falling back to ~/.config/hive.
 *
 * Migration: pre-fix Windows installs wrote to ~/.config/hive. When that
 * legacy directory exists but the new %APPDATA%\hive does not, prefer the
 * legacy path so an upgrade does not surface as an empty workspace list.
 * This is a one-way ratchet — once the new location is populated, it wins.
 *
 * Lives in its own module so `hive remote` (and its tests) can resolve the
 * data dir without importing the daemon entry, which would pull the entire
 * server graph.
 */
export const resolveDataDir = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync
): string => {
  const override = env.HIVE_DATA_DIR
  if (override) return override

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    const target = join(appData, 'hive')
    const legacy = join(homedir(), '.config', 'hive')
    if (!pathExists(target) && pathExists(legacy)) return legacy
    return target
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'hive')
}
