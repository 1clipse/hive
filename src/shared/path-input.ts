/**
 * Normalize a path pasted into a workspace input. Windows Explorer's
 * "Copy as path" wraps the value in double quotes (e.g. `"C:\\Users\\me"`);
 * shell-style paste from a terminal sometimes uses single quotes. Resolving
 * the quoted form with `realpathSync` fails even though the unquoted path is
 * valid.
 *
 * The heuristic is intentionally conservative: only a symmetric outer pair
 * of identical quote characters is removed. Asymmetric or interior quotes
 * survive so legitimately quote-containing paths still reach the server.
 */
export const sanitizePastedPath = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
