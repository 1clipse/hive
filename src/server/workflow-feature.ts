/**
 * Workflow experimental feature gate.
 *
 * Workflows (`team workflow run`, the scheduler, the UI drawer, and the chunk
 * of orchestrator guidance that teaches them) are a power feature with sharp
 * edges — runaway fan-outs, authoring footguns, no run-resume yet. They ship
 * OFF by default; a user opts in from Settings. While off, the orchestrator is
 * not even taught about workflows, which also keeps its always-on prompt lean.
 *
 * Stored GLOBALLY in `app_state` under WORKFLOW_ENABLED_KEY. Absent / anything
 * other than the exact string "true" reads back as DISABLED.
 */

export const WORKFLOW_ENABLED_KEY = 'workflow.enabled'

export const readWorkflowEnabled = (raw: string | null | undefined): boolean => raw === 'true'

export const serializeWorkflowEnabled = (enabled: boolean): string => (enabled ? 'true' : 'false')
