import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import type { WorkflowRunRecord } from './workflow-run-store.js'
import type { WorkflowScheduleRecord } from './workflow-schedule-store.js'

export const serializeLiveAgentRun = (run: LiveAgentRun) => ({
  agent_id: run.agentId,
  exit_code: run.exitCode,
  output: run.output,
  pid: run.pid,
  run_id: run.runId,
  started_at: run.startedAt,
  status: run.status,
})

export const serializeWorkflowRun = (run: WorkflowRunRecord) => ({
  agent_count: run.agentCount,
  args: run.args,
  created_at: run.createdAt,
  error: run.error,
  finished_at: run.finishedAt,
  id: run.id,
  name: run.name,
  parent_run_id: run.parentRunId,
  phase: run.phase,
  result: run.result,
  script_hash: run.scriptHash,
  script_path: run.scriptPath,
  started_at: run.startedAt,
  status: run.status,
  workspace_id: run.workspaceId,
})

export const serializeWorkflowDispatch = (dispatch: DispatchRecord & { lastPtyLine?: string }) => ({
  artifacts: dispatch.artifacts,
  created_at: dispatch.createdAt,
  delivered_at: dispatch.deliveredAt,
  from_agent_id: dispatch.fromAgentId,
  id: dispatch.id,
  label: dispatch.label,
  last_pty_line: dispatch.lastPtyLine ?? null,
  phase: dispatch.phase,
  reported_at: dispatch.reportedAt,
  report_text: dispatch.reportText,
  sequence: dispatch.sequence,
  status: dispatch.status,
  step_index: dispatch.stepIndex,
  submitted_at: dispatch.submittedAt,
  text: dispatch.text,
  to_agent_id: dispatch.toAgentId,
  workflow_run_id: dispatch.workflowRunId,
  workspace_id: dispatch.workspaceId,
})

export const serializeWorkflowSchedule = (schedule: WorkflowScheduleRecord) => ({
  args: schedule.args,
  created_at: schedule.createdAt,
  cron: schedule.cron,
  enabled: schedule.enabled,
  id: schedule.id,
  last_run_at: schedule.lastRunAt,
  next_run_at: schedule.nextRunAt,
  script_path: schedule.scriptPath,
  updated_at: schedule.updatedAt,
  workspace_id: schedule.workspaceId,
})
