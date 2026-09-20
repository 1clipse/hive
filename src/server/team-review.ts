import { isTeamReviewRole, TEAM_REVIEW_TASK_PREFIX, type TeamReviewRole } from '../shared/types.js'
import type { UiLanguage } from '../shared/ui-language.js'
import { isCommandAvailableOnPath } from './agent-command-resolver.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { BadRequestError, ConflictError } from './http-errors.js'
import { getDefaultRoleDescription } from './role-templates.js'
import {
  resolveExplicitSpawnCliLaunchConfig,
  type SpawnCliResolverPorts,
} from './spawn-cli-resolver.js'
import { resolveSpawnWorkerDefaults } from './spawn-worker-defaults.js'
import { canonicalCliFamily, commandVendorToken } from './startup-command-parser.js'
import { getOrchestratorId } from './workspace-store-support.js'

export const buildReviewTaskText = (focus: string) =>
  `${TEAM_REVIEW_TASK_PREFIX}\n\nFocus: ${focus}`

export interface TeamReviewStore {
  addWorkerWithLaunch: (
    workspaceId: string,
    input: {
      description?: string
      ephemeral?: boolean
      name: string
      role: TeamReviewRole
      spawnedBy?: 'orchestrator'
    },
    launchConfig: AgentLaunchConfigInput
  ) => { id: string; name: string }
  deleteWorker: (workspaceId: string, workerId: string) => void
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input: { autoStartWorker?: boolean; fromAgentId: string; hivePort: string }
  ) => Promise<{ id: string }>
  listWorkers: (workspaceId: string) => Array<{ name: string }>
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) =>
    | Pick<AgentLaunchConfigInput, 'args' | 'command' | 'commandPresetId' | 'interactiveCommand'>
    | undefined
  getActiveRunByAgentId?: (
    workspaceId: string,
    agentId: string
  ) => { postStartInputReady?: Promise<void>; runId: string; status: string } | undefined
  waitForRunExit?: (runId: string, timeoutMs: number) => Promise<boolean>
  settings: {
    getCommandPreset: SpawnCliResolverPorts['getCommandPreset']
    listCommandPresets: () => Array<{
      args: string[]
      command: string
      env: Record<string, string>
      id: string
    }>
  }
}

export interface StartTeamReviewInput {
  cli?: string
  focus: string
  fromAgentId: string
  hivePort: string
  language?: UiLanguage
  model?: string
  name?: string
  role?: string
  workspaceId: string
}

export interface TeamReviewResult {
  cli: string
  dispatchId: string
  memberName: string
  role: TeamReviewRole
}

const spawnPorts = (store: TeamReviewStore, workspaceId: string): SpawnCliResolverPorts => ({
  getCommandPreset: (id) => store.settings.getCommandPreset(id),
  getOrchestratorLaunchConfig: () =>
    store.peekAgentLaunchConfig(workspaceId, getOrchestratorId(workspaceId)),
})

const appendModelArgs = (
  launchConfig: AgentLaunchConfigInput,
  model: string | undefined
): AgentLaunchConfigInput => {
  if (!model?.trim()) return launchConfig
  return { ...launchConfig, args: [...(launchConfig.args ?? []), '--model', model.trim()] }
}

/* Automatic selection requires two known, different CLI families. Unknown
   wrappers cannot establish independence; explicit --cli remains available. */
const isDifferentCliFromOrchestrator = (store: TeamReviewStore, workspaceId: string) => {
  const config = store.peekAgentLaunchConfig(workspaceId, getOrchestratorId(workspaceId))
  const orchVendor = canonicalCliFamily(
    commandVendorToken(config?.interactiveCommand ?? config?.command, config?.args ?? [])
  )
  const orchPresetId = config?.commandPresetId ?? null
  return (preset: { args: string[]; command: string; id: string }) => {
    if (orchPresetId !== null && preset.id === orchPresetId) return false
    const presetVendor = canonicalCliFamily(commandVendorToken(preset.command, preset.args))
    return orchVendor !== null && presetVendor !== null && presetVendor !== orchVendor
  }
}

const listUsablePresets = (store: TeamReviewStore) =>
  store.settings.listCommandPresets().filter((preset) => {
    const record = store.settings.getCommandPreset(preset.id)
    return record !== undefined && isCommandAvailableOnPath(record.command, record.env)
  })

const resolveReviewLaunchConfig = (
  store: TeamReviewStore,
  workspaceId: string,
  cli: string | undefined,
  model: string | undefined
): { cli: string; launchConfig: AgentLaunchConfigInput } => {
  const ports = spawnPorts(store, workspaceId)
  if (cli) {
    const launchConfig = appendModelArgs(resolveExplicitSpawnCliLaunchConfig(ports, cli), model)
    return { cli, launchConfig }
  }

  const differentCli = isDifferentCliFromOrchestrator(store, workspaceId)
  const usable = listUsablePresets(store)
  const picked = usable.find(differentCli)
  if (!picked) {
    const available = usable.map((preset) => preset.id).join(', ') || '(none)'
    throw new ConflictError(
      'No cross-vendor CLI available: no usable preset has a known different CLI family. ' +
        `Available: ${available}. Pass --cli to choose explicitly.`
    )
  }
  const launchConfig = appendModelArgs(resolveExplicitSpawnCliLaunchConfig(ports, picked.id), model)
  return { cli: picked.id, launchConfig }
}

const resolveReviewRole = (role: string | undefined): TeamReviewRole => {
  const requested = role?.trim() || 'reviewer'
  if (!isTeamReviewRole(requested)) {
    throw new BadRequestError('role must be reviewer or tester')
  }
  return requested
}

/* node-pty often reports starting then dies via onExit (missing binary,
   `exit 1`). Same settle windows as orchestrator-autostart. */
const REVIEWER_START_SETTLE_MS = process.platform === 'win32' ? 2000 : 800
const REVIEWER_SILENT_SETTLE_MS = process.platform === 'win32' ? 5000 : 4000

const isReviewerRunDead = (status: string | undefined) =>
  !status || status === 'error' || status === 'stopped' || status === 'exited'

const assertReviewerRunAlive = async (
  store: TeamReviewStore,
  workspaceId: string,
  workerId: string
) => {
  if (!store.getActiveRunByAgentId) return
  const initial = store.getActiveRunByAgentId(workspaceId, workerId)
  if (initial?.postStartInputReady) await initial.postStartInputReady
  const run = store.getActiveRunByAgentId(workspaceId, workerId)
  if (!run?.runId || isReviewerRunDead(run.status)) {
    throw new ConflictError('Reviewer CLI failed to start')
  }
  if (store.waitForRunExit) {
    await store.waitForRunExit(run.runId, REVIEWER_START_SETTLE_MS)
    const afterSettle = store.getActiveRunByAgentId(workspaceId, workerId)
    if (isReviewerRunDead(afterSettle?.status)) {
      throw new ConflictError('Reviewer CLI failed to start')
    }
    if (afterSettle?.status === 'starting') {
      await store.waitForRunExit(run.runId, REVIEWER_SILENT_SETTLE_MS)
    }
  }
  const afterStart = store.getActiveRunByAgentId(workspaceId, workerId)
  if (isReviewerRunDead(afterStart?.status)) {
    throw new ConflictError('Reviewer CLI failed to start')
  }
}

export const startTeamReview = async (
  store: TeamReviewStore,
  input: StartTeamReviewInput
): Promise<TeamReviewResult> => {
  const focus = input.focus.trim()
  if (!focus) throw new BadRequestError('Missing focus')
  const role = resolveReviewRole(input.role)
  const { cli, launchConfig } = resolveReviewLaunchConfig(
    store,
    input.workspaceId,
    input.cli,
    input.model
  )
  const defaults = resolveSpawnWorkerDefaults({
    ...(input.language ? { language: input.language } : {}),
    requestedName: input.name,
    requestedRole: role,
    takenNames: new Set(store.listWorkers(input.workspaceId).map((worker) => worker.name)),
  })
  const description = getDefaultRoleDescription(role, input.language ?? 'en')
  let worker: { id: string; name: string } | undefined
  try {
    worker = store.addWorkerWithLaunch(
      input.workspaceId,
      {
        description,
        ephemeral: true,
        name: defaults.name,
        role,
        spawnedBy: 'orchestrator',
      },
      launchConfig
    )
    const dispatch = await store.dispatchTaskByWorkerName(
      input.workspaceId,
      worker.name,
      buildReviewTaskText(focus),
      {
        autoStartWorker: true,
        fromAgentId: input.fromAgentId,
        hivePort: input.hivePort,
      }
    )
    await assertReviewerRunAlive(store, input.workspaceId, worker.id)
    return { cli, dispatchId: dispatch.id, memberName: worker.name, role }
  } catch (error) {
    if (worker) {
      try {
        store.deleteWorker(input.workspaceId, worker.id)
      } catch (cleanupError) {
        console.error('[hive] swallowed:teamReview.rollback', cleanupError)
      }
    }
    throw error
  }
}
