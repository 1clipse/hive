import { readWorkflowEnabled, WORKFLOW_ENABLED_KEY } from './workflow-feature.js'

/**
 * Every experimental feature flag resolved into one snapshot.
 *
 * Threading this bag through the prompt-build call graph — instead of one
 * `getX` accessor per flag — is the whole point of this module: a new flag adds
 * a field here and is read at the one site that needs it, without touching any
 * of the carriers in between (agent-runtime → run-starter / restart-policy /
 * tasks-watcher → the pure builders in hive-team-guidance).
 *
 * Each flag keeps its own storage semantics and doc in its own file
 * ([[workflow-feature]]); this module only composes them.
 */
export interface FeatureFlags {
  /** Workflow runtime — `team workflow`, the scheduler, the Drawer, and the
   *  orchestrator guidance that teaches them. Default OFF. */
  workflowsEnabled: boolean
}

/**
 * Conservative all-off snapshot. Use as the parameter default wherever a
 * builder is called without flags — it preserves the per-flag `= false`
 * defaults the builders carried before this registry existed.
 *
 * Only an OMITTED argument falls back to off, which is the safe choice
 * (never inject guidance for a flag nobody resolved).
 */
export const FEATURE_FLAGS_ALL_OFF: FeatureFlags = {
  workflowsEnabled: false,
}

interface AppStateReader {
  getAppState: (key: string) => { value: string | null } | undefined
}

/**
 * Read every flag from app_state into one snapshot, each with its own storage
 * default (workflows off-when-absent). Called fresh each time so a Settings
 * toggle takes effect without restarting the runtime.
 */
export const readFeatureFlags = (settings: AppStateReader): FeatureFlags => ({
  workflowsEnabled: readWorkflowEnabled(settings.getAppState(WORKFLOW_ENABLED_KEY)?.value ?? null),
})
