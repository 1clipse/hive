/**
 * Install guidance for the built-in CLI presets (growth research P0-B1:
 * don't dead-end users whose chosen CLI is not installed).
 *
 * Keyed by command-preset id — see `src/server/command-preset-defaults.ts`
 * for the authoritative preset list. `command` is the official one-line
 * install for macOS/Linux; `docsUrl` is the official install page and covers
 * Windows and alternative install paths.
 *
 * Every npm package name below was verified against the npm registry and the
 * vendor's official docs on 2026-06-11. When adding entries, verify the real
 * package/installer first — never guess a package name, link the docs instead.
 */
export interface CliInstallGuidance {
  /** One-line install command (macOS/Linux), shown with a copy button. */
  command: string
  /** Official install docs for Windows / alternative install methods. */
  docsUrl: string
}

const CLI_INSTALL_GUIDANCE: Record<string, CliInstallGuidance> = {
  agy: {
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docsUrl: 'https://antigravity.google/docs/cli-getting-started',
  },
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://github.com/anthropics/claude-code',
  },
  codex: {
    command: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  cursor: {
    command: 'curl https://cursor.com/install -fsS | bash',
    docsUrl: 'https://cursor.com/docs/cli/installation',
  },
  gemini: {
    command: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  grok: {
    // Grok Build is in beta and xAI has changed the installer before; the
    // docs link is the stable reference if this one-liner drifts.
    command: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://x.ai/cli',
  },
  hermes: {
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    docsUrl: 'https://github.com/NousResearch/hermes-agent',
  },
  opencode: {
    command: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai/docs',
  },
  qwen: {
    command: 'npm install -g @qwen-code/qwen-code@latest',
    docsUrl: 'https://github.com/QwenLM/qwen-code',
  },
}

/** Returns null for custom presets / unknown ids — callers fall back to the PATH help only. */
export const getCliInstallGuidance = (presetId: string): CliInstallGuidance | null =>
  CLI_INSTALL_GUIDANCE[presetId] ?? null
