import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BadRequestError } from './http-errors.js'
import { getWindowsFilenameError } from './windows-filename.js'
import type { createWorkflowScheduleStore } from './workflow-schedule-store.js'

type ScheduleStore = ReturnType<typeof createWorkflowScheduleStore>

// Agent-scheduled workflows persist their inline source to a file under
// <workspace>/.hive/workflows/ so the existing file-based scheduler can load
// it at fire time — no orchestrator is in the loop when cron fires, so the
// source must outlive the request. The file is agent-managed and is
// intentionally NOT surfaced in the UI (workflows are agent-authored, not a
// human script library).
const toScriptFilename = (nameRaw: string): string => {
  const slug = nameRaw
    .trim()
    .toLowerCase()
    .replace(/\.ts$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new BadRequestError('schedule name must contain at least one alphanumeric character')
  }
  const windowsNameProbe = `${slug}.ts`
  const filenameError = getWindowsFilenameError(windowsNameProbe)
  if (filenameError) throw new BadRequestError(`Invalid workflow schedule name: ${filenameError}`)
  return `${slug}-${randomUUID()}.ts`
}

export interface PersistWorkflowScheduleInput {
  workspacePath: string
  scheduleStore: ScheduleStore
  workspaceId: string
  source: string
  name: string
  cron: string
  nextRunAt: number
  args?: unknown
}

export const persistWorkflowSchedule = async (input: PersistWorkflowScheduleInput) => {
  const filename = toScriptFilename(input.name)
  const dir = join(input.workspacePath, '.hive', 'workflows')
  await mkdir(dir, { recursive: true })
  const scriptPath = join(dir, filename)
  await writeFile(scriptPath, input.source, 'utf8')
  return input.scheduleStore.create({
    workspaceId: input.workspaceId,
    scriptPath,
    cron: input.cron,
    nextRunAt: input.nextRunAt,
    ...(input.args !== undefined ? { args: input.args } : {}),
  })
}
