import type { TeamListItem } from '../shared/types.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'

// Privacy note — recap vs. support bundle: dispatch label/phase/reportText are
// workflow-authored free text (the first-party guidance even puts file paths
// in labels). The shareable support bundle therefore reduces them to presence
// flags (see action-center-summary.ts `includeTextEvidence === false`). The
// recap is the opposite case on purpose: the user explicitly clicks "Copy
// recap" to share their own team's progress, so the verbatim text IS the
// product. Do not "sanitize" this output to match the bundle.

const REPORT_PREVIEW_MAX = 200

export interface TeamRecapInput {
  /** Recent dispatches, newest first (listRecentWorkspaceDispatches order). */
  dispatches: DispatchRecord[]
  now: number
  workers: TeamListItem[]
  workspaceName: string
}

/** Markdown table cells cannot contain raw pipes or newlines. */
const tableCell = (text: string): string => text.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|')

const truncate = (text: string, max: number): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

const dispatchTimestamp = (dispatch: DispatchRecord): number =>
  dispatch.reportedAt ?? dispatch.submittedAt ?? dispatch.deliveredAt ?? dispatch.createdAt

const formatAge = (timestamp: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export const buildTeamRecapMarkdown = (input: TeamRecapInput): string => {
  const workersById = new Map(input.workers.map((worker) => [worker.id, worker]))
  const workerName = (agentId: string): string => workersById.get(agentId)?.name ?? agentId

  const lines: string[] = []
  lines.push(`# Team recap — ${input.workspaceName}`)
  lines.push('')
  lines.push(`Generated at ${new Date(input.now).toISOString()}`)
  lines.push('')

  lines.push('## Team')
  lines.push('')
  if (input.workers.length === 0) {
    lines.push('_No team members._')
  } else {
    for (const worker of input.workers) {
      lines.push(`- **${worker.name}** — ${worker.role} · ${worker.status}`)
    }
  }
  lines.push('')

  lines.push('## Recent dispatches')
  lines.push('')
  if (input.dispatches.length === 0) {
    lines.push('_No dispatches yet._')
  } else {
    lines.push('| Label | Status | Worker | Age |')
    lines.push('| --- | --- | --- | --- |')
    for (const dispatch of input.dispatches) {
      const label = dispatch.label ?? dispatch.phase ?? truncate(dispatch.text, 60)
      const age = formatAge(dispatchTimestamp(dispatch), input.now)
      lines.push(
        `| ${tableCell(label)} | ${dispatch.status} | ${tableCell(workerName(dispatch.toAgentId))} | ${age} |`
      )
    }
  }
  lines.push('')

  const reported = input.dispatches.filter(
    (dispatch) => dispatch.status === 'reported' && dispatch.reportText
  )
  if (reported.length > 0) {
    lines.push('## Reports')
    lines.push('')
    for (const dispatch of reported) {
      const heading = dispatch.label ?? dispatch.phase ?? workerName(dispatch.toAgentId)
      lines.push(`### ${truncate(heading, 80)}`)
      lines.push('')
      lines.push(truncate(dispatch.reportText ?? '', REPORT_PREVIEW_MAX))
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}
