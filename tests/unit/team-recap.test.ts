import { describe, expect, test } from 'vitest'

import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { buildTeamRecapMarkdown } from '../../src/server/team-recap.js'
import type { TeamListItem } from '../../src/shared/types.js'

const NOW = Date.UTC(2026, 5, 11, 12, 0, 0)

const worker = (overrides: Partial<TeamListItem> = {}): TeamListItem => ({
  id: 'worker-1',
  name: 'Ada',
  pendingTaskCount: 0,
  role: 'coder',
  status: 'idle',
  ...overrides,
})

const dispatch = (overrides: Partial<DispatchRecord> = {}): DispatchRecord => ({
  artifacts: [],
  createdAt: NOW - 10 * 60_000,
  deliveredAt: null,
  dispatchPayloadBytes: null,
  fromAgentId: 'orch-1',
  id: 'dispatch-1',
  label: null,
  phase: null,
  reportedAt: null,
  reportText: null,
  reportPayloadBytes: null,
  sequence: 1,
  status: 'queued',
  stepIndex: null,
  submittedAt: null,
  text: 'Implement the login form',
  toAgentId: 'worker-1',
  workflowRunId: null,
  workspaceId: 'ws-1',
  ...overrides,
})

describe('buildTeamRecapMarkdown', () => {
  test('empty team renders placeholders instead of empty sections', () => {
    const markdown = buildTeamRecapMarkdown({
      dispatches: [],
      now: NOW,
      workers: [],
      workspaceName: 'My Project',
    })

    expect(markdown).toContain('# Team recap — My Project')
    expect(markdown).toContain('_No team members._')
    expect(markdown).toContain('_No dispatches yet._')
    // No dispatch table and no report section for an empty workspace.
    expect(markdown).not.toContain('| Label |')
    expect(markdown).not.toContain('## Reports')
  })

  test('renders member roster, dispatch table row, and report excerpt', () => {
    const markdown = buildTeamRecapMarkdown({
      dispatches: [
        dispatch({
          id: 'dispatch-2',
          label: 'Fix flaky test',
          reportedAt: NOW - 3 * 60_000,
          reportText: 'Stabilized the retry loop and re-ran the suite.',
          status: 'reported',
          submittedAt: NOW - 8 * 60_000,
        }),
        dispatch({ id: 'dispatch-3', status: 'submitted', submittedAt: NOW - 2 * 3600_000 }),
      ],
      now: NOW,
      workers: [
        worker({ status: 'working' }),
        worker({ id: 'worker-2', name: 'Grace', role: 'reviewer', status: 'stopped' }),
      ],
      workspaceName: 'Hive',
    })

    expect(markdown).toContain('- **Ada** — coder · working')
    expect(markdown).toContain('- **Grace** — reviewer · stopped')
    // Reported row: label, status, resolved worker name, age from reportedAt.
    expect(markdown).toContain('| Fix flaky test | reported | Ada | 3m |')
    // Submitted row without label falls back to dispatch text; age from submittedAt.
    expect(markdown).toContain('| Implement the login form | submitted | Ada | 2h |')
    // Report section carries the verbatim report text under the dispatch label.
    expect(markdown).toContain('### Fix flaky test')
    expect(markdown).toContain('Stabilized the retry loop and re-ran the suite.')
  })

  test('truncates long reportText to 200 chars', () => {
    const longReport = 'x'.repeat(450)
    const markdown = buildTeamRecapMarkdown({
      dispatches: [
        dispatch({
          label: 'Big task',
          reportedAt: NOW - 60_000,
          reportText: longReport,
          status: 'reported',
        }),
      ],
      now: NOW,
      workers: [worker()],
      workspaceName: 'Hive',
    })

    expect(markdown).toContain(`${'x'.repeat(200)}...`)
    expect(markdown).not.toContain('x'.repeat(201))
  })

  test('escapes pipes and newlines in free-text labels so the table survives', () => {
    const markdown = buildTeamRecapMarkdown({
      dispatches: [dispatch({ label: 'fix a | b\nand c', status: 'queued' })],
      now: NOW,
      workers: [worker()],
      workspaceName: 'Hive',
    })

    expect(markdown).toContain('| fix a \\| b and c | queued | Ada | 10m |')
  })

  test('sections appear in recap order: title, team, dispatches, reports', () => {
    const markdown = buildTeamRecapMarkdown({
      dispatches: [
        dispatch({ label: 'Task A', reportedAt: NOW, reportText: 'done', status: 'reported' }),
      ],
      now: NOW,
      workers: [worker()],
      workspaceName: 'Hive',
    })

    const title = markdown.indexOf('# Team recap — Hive')
    const team = markdown.indexOf('## Team')
    const dispatches = markdown.indexOf('## Recent dispatches')
    const reports = markdown.indexOf('## Reports')
    expect(title).toBe(0)
    expect(team).toBeGreaterThan(title)
    expect(dispatches).toBeGreaterThan(team)
    expect(reports).toBeGreaterThan(dispatches)
  })

  test('unknown worker id falls back to the agent id, not a crash or blank cell', () => {
    const markdown = buildTeamRecapMarkdown({
      dispatches: [dispatch({ label: 'Orphan', toAgentId: 'ghost-9' })],
      now: NOW,
      workers: [],
      workspaceName: 'Hive',
    })

    expect(markdown).toContain('| Orphan | queued | ghost-9 | 10m |')
  })
})
