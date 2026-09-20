import { arch, platform, release } from 'node:os'
import { basename, win32 } from 'node:path'

import type { WorkspaceSummary } from '../shared/types.js'
import { buildActionCenterSummary } from './action-center-summary.js'
import { toCollaborationAggregate } from './collaboration-metrics.js'
import {
  DEFAULT_GATEWAY_URL,
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from './remote-config-keys.js'
import type { RuntimeStore } from './runtime-store.js'
import type { VersionInfoPayload } from './version-service.js'

const ACTIVE_WORKSPACE_KEY = 'active_workspace_id'
const MAX_INCLUDED_WORKSPACES = 5
const MAX_WORKERS_PER_WORKSPACE = 20
const MAX_RUNS_PER_WORKSPACE = 20
const MAX_RECENT_DISPATCHES = 20
const MAX_REMOTE_AUDIT = 50

const detectPathKind = (workspacePath: string): 'windows' | 'posix' | 'unknown' => {
  if (/^[a-z]:[\\/]/iu.test(workspacePath) || workspacePath.includes('\\')) return 'windows'
  if (workspacePath.startsWith('/')) return 'posix'
  return 'unknown'
}

const redactWorkspacePath = (workspacePath: string) => {
  const pathKind = detectPathKind(workspacePath)
  const base =
    pathKind === 'windows'
      ? win32.basename(workspacePath)
      : basename(workspacePath) || workspacePath
  const trimmed = workspacePath.replace(/[\\/]+$/u, '')
  const hasParent = pathKind === 'windows' ? trimmed.includes('\\') : trimmed.includes('/')
  return {
    basename: base || null,
    has_parent: hasParent,
    path_kind: pathKind,
  }
}

const isLoggedIn = (store: RuntimeStore): boolean =>
  (store.settings.getAppState(REMOTE_GATEWAY_URL_KEY)?.value ?? null) !== null &&
  (store.settings.getAppState(REMOTE_DAEMON_TOKEN_KEY)?.value ?? null) !== null

const buildRemoteSummary = (store: RuntimeStore) => {
  const devices = store.getRemoteDeviceStore().list(true)
  const activeDevices = devices.filter((device) => device.revokedAt === null)
  const lastActiveValues = devices
    .map((device) => device.lastActive)
    .filter((value): value is number => typeof value === 'number')
  // A self-hosted gateway URL is private infrastructure; the shareable bundle
  // only names the default gateway and otherwise records that a custom one is
  // in use.
  const gatewayUrl = store.settings.getAppState(REMOTE_GATEWAY_URL_KEY)?.value ?? null
  const gatewayUrlIsCustom = gatewayUrl !== null && gatewayUrl !== DEFAULT_GATEWAY_URL
  return {
    status: {
      connected: store.getRemoteTunnelStatus() === 'online',
      connection: store.getRemoteTunnelStatus(),
      enabled: store.settings.getAppState(REMOTE_ENABLED_KEY)?.value === 'true',
      gateway_url: gatewayUrlIsCustom ? null : gatewayUrl,
      gateway_url_custom: gatewayUrlIsCustom,
      logged_in: isLoggedIn(store),
    },
    devices: {
      active_count: activeDevices.length,
      last_active_at: lastActiveValues.length > 0 ? Math.max(...lastActiveValues) : null,
      revoked_count: devices.length - activeDevices.length,
      total_count: devices.length,
    },
    recent_audit: store
      .getRemoteAuditStore()
      .list(MAX_REMOTE_AUDIT)
      .map((entry) => ({
        action: entry.action,
        byte_count: entry.byteCount,
        device_id: entry.deviceId,
        endpoint: entry.endpoint,
        has_preview: Boolean(entry.preview),
        id: entry.id,
        reject_reason: entry.rejectReason,
        result: entry.result,
        ts: entry.ts,
        workspace_id: entry.workspaceId,
      })),
  }
}

const buildWorkspaceDiagnostics = (store: RuntimeStore, workspace: WorkspaceSummary) => {
  const allWorkers = store.listWorkers(workspace.id)
  const workers = allWorkers.slice(0, MAX_WORKERS_PER_WORKSPACE)
  const workerNameById = new Map(workers.map((worker) => [worker.id, worker.name]))
  const dispatches = store.listRecentDispatches(workspace.id, MAX_RECENT_DISPATCHES)

  return {
    action_center: buildActionCenterSummary({
      includeTextEvidence: false,
      store,
      workspaceId: workspace.id,
    }),
    collaboration: toCollaborationAggregate(store.getCollaborationMetrics(workspace.id)),
    id: workspace.id,
    name: workspace.name,
    path: redactWorkspacePath(workspace.path),
    recent_dispatches: dispatches.map((dispatch) => ({
      artifact_count: dispatch.artifacts.length,
      created_at: dispatch.createdAt,
      from_agent_id: dispatch.fromAgentId,
      has_label: dispatch.label !== null,
      has_phase: dispatch.phase !== null,
      has_report: Boolean(dispatch.reportText),
      id: dispatch.id,
      report_text_length: dispatch.reportText?.length ?? 0,
      reported_at: dispatch.reportedAt,
      status: dispatch.status,
      submitted_at: dispatch.submittedAt,
      task_text_length: dispatch.text.length,
      to_agent_id: dispatch.toAgentId,
      to_worker_name: workerNameById.get(dispatch.toAgentId) ?? null,
      workflow_run_id: dispatch.workflowRunId,
    })),
    runs: store.listTerminalRuns(workspace.id).slice(0, MAX_RUNS_PER_WORKSPACE),
    workers: workers.map((worker) => ({
      command_preset_id:
        worker.commandPresetId ??
        store.peekAgentLaunchConfig(workspace.id, worker.id)?.commandPresetId ??
        null,
      ephemeral: worker.ephemeral === true,
      has_last_pty_line: Boolean(store.getLastPtyLineForAgent(workspace.id, worker.id)),
      id: worker.id,
      name: worker.name,
      pending_task_count: worker.pendingTaskCount,
      role: worker.role,
      spawned_by: worker.spawnedBy ?? null,
      status: worker.status,
    })),
    workers_truncated: allWorkers.length > MAX_WORKERS_PER_WORKSPACE,
  }
}

export const buildDiagnosticsSupportBundle = (input: {
  now?: number
  store: RuntimeStore
  version: VersionInfoPayload
}) => {
  const now = input.now ?? Date.now()
  const workspaces = input.store.listWorkspaces()
  const includedWorkspaces = workspaces.slice(0, MAX_INCLUDED_WORKSPACES)

  return {
    app: {
      can_run_hive_update: input.version.can_run_hive_update,
      current_version: input.version.current_version,
      install_hint: input.version.install_hint,
      install_source: input.version.install_source,
      latest_version: input.version.latest_version,
      package_name: input.version.package_name,
      update_note: input.version.update_note,
      update_available: input.version.update_available,
    },
    generated_at: now,
    /* Local-only per-day protocol activity counters (issue #23) and
       per-workspace collaboration cost aggregates (issue #75) — counts and
       timings only, no task text; never transmitted. */
    retention: input.store.getRetentionSignals(),
    privacy: {
      omitted: [
        'tokens',
        'cookies',
        'remote_device_keys',
        'environment_variables',
        'full_terminal_transcripts',
        'remote_ws_input_previews',
        'dispatch_text_previews',
        'report_text_previews',
        'last_pty_line_previews',
        'project_source_files',
        'full_workspace_paths',
        'custom_gateway_urls',
      ],
      included_as_metadata_only: [
        'dispatch_text',
        'report_text',
        'last_pty_line',
        'dispatch_labels',
        'dispatch_phases',
      ],
    },
    remote: buildRemoteSummary(input.store),
    runtime: {
      arch: arch(),
      node_version: process.version,
      os_release: release(),
      platform: platform(),
    },
    schema_version: 1,
    workspaces: {
      active_workspace_id: input.store.settings.getAppState(ACTIVE_WORKSPACE_KEY)?.value ?? null,
      included_count: includedWorkspaces.length,
      items: includedWorkspaces.map((workspace) =>
        buildWorkspaceDiagnostics(input.store, workspace)
      ),
      total_count: workspaces.length,
      truncated: workspaces.length > includedWorkspaces.length,
    },
  }
}
