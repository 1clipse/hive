import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { realpathNative } from './path-canonicalization.js'

/**
 * Root directory the FS-browse API is allowed to reveal when sandboxing is
 * enabled. Tests and remote/headless setups can set `HIVE_FS_BROWSE_ROOT`.
 * Normal Windows runs skip this sandbox root and browse from the virtual
 * "This PC" drive list; POSIX sandboxed browsing defaults to `$HOME`.
 */
export const getFsBrowseRoot = (): string => {
  const override = process.env.HIVE_FS_BROWSE_ROOT
  const root = override && override.length > 0 ? resolve(override) : resolve(homedir())
  try {
    return realpathNative(root)
  } catch {
    return root
  }
}

export const hasFsBrowseRootOverride = (): boolean =>
  (process.env.HIVE_FS_BROWSE_ROOT ?? '').length > 0

const isResolvedPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  if (candidatePath === rootPath) return true
  const rel = relative(rootPath, candidatePath)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * True when `candidatePath` is `rootPath` itself or a descendant of it.
 * Uses `path.relative` + separator check so Windows back-slashes and drive
 * boundaries are handled correctly — identical shape to kanban's
 * isPathWithinRoot so the semantics match a project we already trust.
 */
export const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  const lexicalRoot = resolve(rootPath)
  const lexicalCandidate = resolve(candidatePath)
  let resolvedRoot = lexicalRoot
  let resolvedCandidate = lexicalCandidate
  try {
    resolvedRoot = realpathNative(resolvedRoot)
  } catch {
    // Missing / inaccessible roots are handled by the caller's readdir/stat path.
  }
  try {
    resolvedCandidate = realpathNative(resolvedCandidate)
  } catch {
    // Non-existent children still need lexical sandboxing for "create later"
    // probes; existing symlinks/junctions use the realpath branch above.
    if (isResolvedPathWithinRoot(lexicalRoot, lexicalCandidate)) {
      resolvedRoot = lexicalRoot
      resolvedCandidate = lexicalCandidate
    }
  }
  return isResolvedPathWithinRoot(resolvedRoot, resolvedCandidate)
}
