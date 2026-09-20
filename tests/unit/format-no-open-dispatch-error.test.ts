import { describe, expect, test } from 'vitest'

import type { DispatchRecord } from '../../src/server/dispatch-ledger-store.js'
import { formatNoOpenDispatchError } from '../../src/server/team-operations.js'

const makeDispatch = (overrides: Partial<DispatchRecord>): DispatchRecord =>
  ({
    artifacts: [],
    createdAt: 0,
    deliveredAt: null,
    fromAgentId: 'ws:orchestrator',
    id: 'dispatch-a',
    reportedAt: null,
    reportText: null,
    sequence: 1,
    status: 'submitted',
    submittedAt: 0,
    text: 'Implement login',
    toAgentId: 'worker-1',
    workspaceId: 'ws',
    ...overrides,
  }) as DispatchRecord

describe('formatNoOpenDispatchError', () => {
  test('wrong --dispatch id with other dispatches open lists context but forbids settling an unrelated responsibility', () => {
    const message = formatNoOpenDispatchError('Alice', 'dispatch-stale', [
      makeDispatch({ id: 'dispatch-a', text: 'Implement login' }),
      makeDispatch({ id: 'dispatch-b', status: 'queued', text: 'Write tests' }),
    ])
    expect(message).toContain('Dispatch dispatch-stale is not open for worker Alice')
    expect(message).toContain('dispatch-a (submitted): Implement login')
    expect(message).toContain('dispatch-b (queued): Write tests')
    expect(message).toContain('Do not change the dispatch ID to settle an unrelated task')
    expect(message).toContain('team messages --dispatch <id>')
    expect(message).toContain('if it is already closed, do not report it again')
    expect(message).not.toContain('omit --dispatch')
  })

  test('long task text is truncated in the listing', () => {
    const message = formatNoOpenDispatchError('Alice', 'dispatch-stale', [
      makeDispatch({ id: 'dispatch-a', text: 'x'.repeat(100) }),
    ])
    expect(message).toContain(`${'x'.repeat(60)}…`)
    expect(message).not.toContain('x'.repeat(61))
  })

  test('no open dispatches at all points the worker at team status, not a report retry', () => {
    const message = formatNoOpenDispatchError('Alice', 'dispatch-stale', [])
    expect(message).toContain('No open dispatch for worker: Alice')
    expect(message).toContain('team status')
    expect(message).not.toContain('Re-run')
  })

  test('report without --dispatch and nothing open gets the team status hint, never an id listing', () => {
    const message = formatNoOpenDispatchError('Alice', undefined, [
      makeDispatch({ id: 'dispatch-a' }),
    ])
    // A single leftover listing after findOpenDispatch missed is still the
    // team-status hint — not an id menu for an id the worker never asked for.
    expect(message).toContain('No open dispatch for worker: Alice')
    expect(message).toContain('team status')
  })

  test('report without --dispatch and two submitted rows lists them for an explicit id', () => {
    const message = formatNoOpenDispatchError('Alice', undefined, [
      makeDispatch({ id: 'dispatch-a', text: 'Implement login' }),
      makeDispatch({ id: 'dispatch-b', text: 'Write tests' }),
    ])
    expect(message).toContain('more than one submitted dispatch')
    expect(message).toContain('dispatch-a (submitted): Implement login')
    expect(message).toContain('dispatch-b (submitted): Write tests')
    expect(message).toContain('team report --dispatch <id>')
  })
})
