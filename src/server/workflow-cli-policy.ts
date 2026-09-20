/**
 * Workflow CLI policy — controls which CLI a workflow's `agent()` spawns.
 *
 * Before this, the runner hard-coded `opts.cli ?? 'claude'`: a user who only
 * had Codex set up would have every workflow agent that omitted `cli` spawn a
 * `claude` it can't run. The policy makes the default configurable and lets
 * the user constrain which CLIs workflow agents may use.
 *
 * Stored GLOBALLY in `app_state` (CLI availability is a machine-level fact, not
 * per-workspace) under WORKFLOW_CLI_POLICY_KEY as a JSON `{default, allowed}`.
 * An absent/malformed value reads back as DEFAULT_WORKFLOW_CLI_POLICY, which is
 * unrestricted and defaults to `claude` — i.e. exactly the old behavior, so
 * upgrading without configuring anything changes nothing.
 */

import type { BuiltinCommandPresetId } from './command-preset-defaults.js'

/**
 * Canonical workflow-capable CLIs. This is intentionally narrower than every
 * built-in command preset: editor/assistant presets that do not support the
 * Hive worker report loop should not become workflow agent targets merely by
 * existing in settings.
 */
export const CANONICAL_WORKFLOW_CLIS = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'hermes',
  'qwen',
  'pi',
  'agy',
] as const satisfies readonly BuiltinCommandPresetId[]

export type WorkflowCli = (typeof CANONICAL_WORKFLOW_CLIS)[number]

export const WORKFLOW_CLI_POLICY_KEY = 'workflow.cli-policy'

export interface WorkflowCliPolicy {
  /** CLI used when an `agent()` call omits `cli` and isn't a custom template. */
  default: string
  /** CLIs an explicit `opts.cli` (and the default fallback) may use. */
  allowed: string[]
}

export const DEFAULT_WORKFLOW_CLI_POLICY: WorkflowCliPolicy = {
  default: 'claude',
  allowed: [...CANONICAL_WORKFLOW_CLIS],
}

const isCanonical = (value: unknown): value is WorkflowCli =>
  typeof value === 'string' && (CANONICAL_WORKFLOW_CLIS as readonly string[]).includes(value)

/** Canonical entries from `input`, deduped and in canonical order. */
const sanitizeAllowed = (input: unknown): string[] => {
  if (!Array.isArray(input)) return []
  const set = new Set(input.filter(isCanonical))
  return CANONICAL_WORKFLOW_CLIS.filter((cli) => set.has(cli))
}

/**
 * Lenient coercion used by the runtime reader: turn arbitrary stored data into
 * a usable policy, never throwing. Junk in `allowed` is dropped; an empty
 * result falls back to the full canonical default; a `default` outside the
 * sanitized `allowed` is pulled back to the first allowed entry.
 */
export const normalizeWorkflowCliPolicy = (input: unknown): WorkflowCliPolicy => {
  if (typeof input !== 'object' || input === null) return DEFAULT_WORKFLOW_CLI_POLICY
  const record = input as Record<string, unknown>
  const allowed = sanitizeAllowed(record.allowed)
  if (allowed.length === 0) return DEFAULT_WORKFLOW_CLI_POLICY
  const requestedDefault = record.default
  const fallback = allowed[0] as string
  const resolvedDefault =
    typeof requestedDefault === 'string' && allowed.includes(requestedDefault)
      ? requestedDefault
      : fallback
  return { default: resolvedDefault, allowed }
}

/** Parse the raw `app_state` string. Absent / malformed → canonical default. */
export const readWorkflowCliPolicy = (raw: string | null | undefined): WorkflowCliPolicy => {
  if (raw === null || raw === undefined) return DEFAULT_WORKFLOW_CLI_POLICY
  try {
    return normalizeWorkflowCliPolicy(JSON.parse(raw))
  } catch {
    return DEFAULT_WORKFLOW_CLI_POLICY
  }
}

/**
 * Strict validation for the settings API: reject bad input so a malformed
 * policy can never be persisted (the reader tolerates junk, but we'd rather
 * fail the write than silently store something the user didn't intend).
 */
export const assertValidWorkflowCliPolicy = (input: unknown): WorkflowCliPolicy => {
  if (typeof input !== 'object' || input === null) {
    throw new Error('workflow cli policy must be an object { default, allowed }')
  }
  const record = input as Record<string, unknown>
  if (!Array.isArray(record.allowed)) {
    throw new Error('workflow cli policy `allowed` must be an array')
  }
  if (record.allowed.length === 0) {
    throw new Error('workflow cli policy `allowed` must list at least one CLI')
  }
  const bad = record.allowed.find((entry) => !isCanonical(entry))
  if (bad !== undefined) {
    throw new Error(
      `workflow cli policy "allowed" has an unsupported CLI: ${JSON.stringify(bad)}. Supported: ${CANONICAL_WORKFLOW_CLIS.join(', ')}`
    )
  }
  if (typeof record.default !== 'string' || !record.allowed.includes(record.default)) {
    throw new Error(
      `workflow cli policy "default" (${JSON.stringify(record.default)}) must be one of allowed: ${record.allowed.join(', ')}`
    )
  }
  // Dedupe + canonical order while preserving the (now-validated) selection.
  return { default: record.default, allowed: sanitizeAllowed(record.allowed) }
}

export interface ResolveWorkflowCliInput {
  /** `opts.cli` from the `agent()` call, if any. */
  requestedCli?: string
  /** True when `agentType` resolved to a workspace custom role template. */
  isCustomTemplate: boolean
  /** The custom template's `defaultCommand` (only consulted when custom). */
  templateDefaultCommand?: string
  policy: WorkflowCliPolicy
}

/**
 * Resolve the CLI command a workflow agent should launch with.
 *
 * - An explicit `requestedCli` is ALWAYS validated against `allowed` (throws
 *   if disallowed, so the orchestrator gets a clear, fixable error).
 * - When omitted: a custom template keeps its own `defaultCommand` (the user
 *   curated that role deliberately — exempt from the allowlist); a built-in
 *   role falls back to `policy.default`.
 */
export const resolveWorkflowCli = ({
  requestedCli,
  isCustomTemplate,
  templateDefaultCommand,
  policy,
}: ResolveWorkflowCliInput): string => {
  const explicit = requestedCli?.trim()
  if (explicit) {
    if (!policy.allowed.includes(explicit)) {
      throw new Error(
        `Workflow agent cli '${explicit}' is not allowed in this workspace. ` +
          `Allowed: ${policy.allowed.join(', ')}. ` +
          `Pick an allowed cli, or change the workflow CLI policy in Settings.`
      )
    }
    return explicit
  }
  if (isCustomTemplate && templateDefaultCommand) return templateDefaultCommand
  return policy.default
}
