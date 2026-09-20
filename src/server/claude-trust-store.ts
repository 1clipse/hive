import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code records per-directory trust under projects[<absolute cwd>] in
// ~/.claude.json. When that entry is missing (or hasTrustDialogAccepted is
// false), claude shows a blocking "Do you trust this folder?" modal on first
// launch in that cwd. Pre-seeding the flag before we spawn claude makes the
// modal never appear, which also unblocks Hive's startup-message injection
// (the post-start writer's first-run setup guard would otherwise stall on the
// modal until the hard-timeout fallback fires into a still-open dialog).

const getClaudeConfigPath = (homeDir: string) => join(homeDir, '.claude.json')

type ClaudeConfig = {
  projects?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

const readClaudeConfig = (configPath: string): ClaudeConfig => {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ClaudeConfig
    }
  } catch {
    // Missing or corrupt file: start from an empty config rather than throwing.
    // A malformed ~/.claude.json is claude's to repair; we only add our key.
  }
  return {}
}

/**
 * Ensure ~/.claude.json marks `cwd` as a trusted folder so claude does not show
 * its first-run trust modal there. Merges into the existing config in place:
 * only the target project entry's trust flags are touched; every other project
 * and every top-level field is preserved. Writes atomically (temp + rename) so
 * a crash mid-write cannot truncate this large shared file.
 *
 * Never throws — a failure here just degrades to claude showing its modal (the
 * pre-existing behaviour), so it must not block member startup.
 *
 * @param cwd      Absolute workspace path claude will launch in (the project key).
 * @param homeDir  Home directory override, for tests. Defaults to os.homedir().
 */
export const ensureClaudeDirectoryTrusted = (cwd: string, homeDir: string = homedir()): void => {
  try {
    const configPath = getClaudeConfigPath(homeDir)
    const config = readClaudeConfig(configPath)
    const projects = config.projects ?? {}
    const existing = projects[cwd] ?? {}

    if (
      existing.hasTrustDialogAccepted === true &&
      Number(existing.projectOnboardingSeenCount) >= 1
    ) {
      return
    }

    const nextConfig: ClaudeConfig = {
      ...config,
      projects: {
        ...projects,
        [cwd]: {
          ...existing,
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: Math.max(1, Number(existing.projectOnboardingSeenCount) || 0),
        },
      },
    }

    const tempPath = `${configPath}.hive-${process.pid}.tmp`
    writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
    renameSync(tempPath, configPath)
  } catch (error) {
    console.error('[hive] swallowed:claudeTrustStore.ensureTrusted', error)
  }
}
