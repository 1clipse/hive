/**
 * Pick the separator that matches the input path's own style. The web UI
 * receives workspace paths in whatever shape the server emitted (POSIX
 * `/usr/local/project`, Windows `C:\Users\me\project`, occasionally
 * mixed when an external tool already normalized one half), and any UI
 * code that wants to display a child path under the workspace must
 * append using the same separator — otherwise the user sees
 * `C:\repo/.hive/tasks.md` and assumes the path is broken even when the
 * filesystem will still accept it.
 *
 * Resolution order:
 *   1. Whichever separator appears later in the string wins.
 *   2. If only one kind appears anywhere, use it.
 *   3. With no separator in the string at all, default to '\\' for a
 *      drive-letter prefix (`C:`) and '/' everywhere else.
 */
export const detectPathSeparator = (input: string): '\\' | '/' => {
  const lastBackslash = input.lastIndexOf('\\')
  const lastSlash = input.lastIndexOf('/')
  if (lastBackslash >= 0 && lastBackslash > lastSlash) return '\\'
  if (lastSlash >= 0) return '/'
  return /^[A-Za-z]:/u.test(input) ? '\\' : '/'
}

/**
 * Join a workspace-style base path with one or more child segments,
 * using the separator already present in the base. Strips trailing
 * separators from `base` so we never produce double-separators.
 */
export const joinWithDetectedSeparator = (base: string, ...segments: string[]): string => {
  const sep = detectPathSeparator(base)
  const trimmedBase = base.replace(/[\\/]+$/u, '')
  return [trimmedBase, ...segments].join(sep)
}
