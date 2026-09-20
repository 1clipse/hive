import { stripVTControlCharacters } from 'node:util'
import type { AgentRunSnapshot } from './agent-manager.js'

/** Snapshot before failed/ephemeral runs are removed; never log launch arguments or env. */
export const logAgentStartupFailure = (
  run: AgentRunSnapshot,
  cwd: string,
  env: NodeJS.ProcessEnv,
  error: unknown
): void => {
  try {
    const secrets = [...Object.entries(process.env), ...Object.entries(env)]
      .filter(([key, value]) => /token|secret|password|api.?key|authorization/i.test(key) && value)
      .map(([, value]) => stripVTControlCharacters(value as string))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    const redact = (value: string, limit: number): string => {
      let text = stripVTControlCharacters(value)
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
      return text.slice(-limit)
    }
    console.error(
      '[hive] Agent startup failed',
      JSON.stringify({
        agent_id: redact(run.agentId, 1024),
        run_id: redact(run.runId, 1024),
        pid: run.pid,
        cwd: redact(cwd, 4096),
        exit_code: run.exitCode,
        error: redact(error instanceof Error ? error.message : String(error), 1024),
        output_tail: redact(run.output, 4096),
      })
    )
  } catch {
    // Diagnostics must never replace the original failure or interrupt cleanup.
  }
}
