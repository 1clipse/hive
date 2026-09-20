import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Codex records per-directory trust in ~/.codex/config.toml as a table:
//
//   [projects."/abs/path"]
//   trust_level = "trusted"
//
// Without it, codex shows a blocking "Do you trust the contents of this
// directory?" prompt on first launch in that cwd. Like the claude case, this
// also stalls Hive's startup-message injection (the post-start writer's
// first-run setup guard matches "Do you trust" and waits out the hard timeout
// into a still-open dialog). Pre-seeding the table before we spawn codex makes
// the prompt never appear.
//
// --dangerously-bypass-approvals-and-sandbox does NOT cover this: it skips
// command approvals / sandboxing, not the pre-session directory trust gate.

const getCodexDir = (homeDir: string) => join(homeDir, '.codex')
const getCodexConfigPath = (homeDir: string) => join(getCodexDir(homeDir), 'config.toml')

// TOML bare-string keys escape backslash and double-quote (see TOML basic
// strings). POSIX/macOS workspace paths almost never contain these, but quote
// defensively so a stray char cannot corrupt the file.
const toTomlQuotedKey = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// Match the exact section header for this cwd, e.g. [projects."/abs/path"],
// tolerating optional whitespace inside the brackets. Anchored per-line.
const hasProjectSection = (toml: string, cwd: string): boolean => {
  const header = `[projects.${toTomlQuotedKey(cwd)}]`
  return toml.split('\n').some((line) => line.trim() === header)
}

const readConfig = (configPath: string): string => {
  try {
    return readFileSync(configPath, 'utf8')
  } catch {
    // Missing (or unreadable) config: start from empty and let codex own the
    // rest of the file. We only ever append our own project table.
    return ''
  }
}

/**
 * Ensure ~/.codex/config.toml trusts `cwd` so codex does not show its first-run
 * directory-trust prompt there. Appends a `[projects."<cwd>"]` table with
 * `trust_level = "trusted"` only when that section is absent; existing content
 * (every other project table and all top-level settings) is preserved
 * verbatim. Writes atomically (temp + rename).
 *
 * Never throws — a failure degrades to codex showing its prompt (the
 * pre-existing behaviour), so it must not block member startup.
 *
 * @param cwd      Absolute workspace path codex will launch in.
 * @param homeDir  Home directory override, for tests. Defaults to os.homedir().
 */
export const ensureCodexDirectoryTrusted = (cwd: string, homeDir: string = homedir()): void => {
  try {
    const configPath = getCodexConfigPath(homeDir)
    const existing = readConfig(configPath)
    if (hasProjectSection(existing, cwd)) return

    const section = `[projects.${toTomlQuotedKey(cwd)}]\ntrust_level = "trusted"\n`
    // Separate from prior content with a blank line, matching codex's own
    // formatting. An empty/period-terminated file needs no leading newline.
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    const next = `${existing}${separator}${section}`

    mkdirSync(getCodexDir(homeDir), { recursive: true })
    const tempPath = `${configPath}.hive-${process.pid}.tmp`
    writeFileSync(tempPath, next, 'utf8')
    renameSync(tempPath, configPath)
  } catch (error) {
    console.error('[hive] swallowed:codexTrustStore.ensureTrusted', error)
  }
}
