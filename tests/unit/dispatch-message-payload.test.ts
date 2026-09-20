import { describe, expect, test } from 'vitest'

import { buildDispatchMessagePayload } from '../../src/server/dispatch-message-payload.js'
import type { DispatchMessageRecord } from '../../src/shared/team-collaboration.js'

const message = (overrides: Partial<DispatchMessageRecord> = {}): DispatchMessageRecord => ({
  createdAt: 1,
  deliveredAt: null,
  deliveryError: null,
  deliveryState: 'delivering',
  dispatchId: 'd1',
  fromAgentId: 'ws:orchestrator',
  id: 'm1',
  kind: 'note',
  recipientAgentId: 'worker-1',
  replyTo: null,
  sequence: 2,
  sourceDispatchId: null,
  text: 'please also cover logout',
  workspaceId: 'ws',
  ...overrides,
})

describe('buildDispatchMessagePayload', () => {
  test('adds required_seen_seq for worker recipients and interpolates N into --seen advice', () => {
    const payload = buildDispatchMessagePayload(message(), 2)
    expect(payload.split('\n').filter((line) => line === 'required_seen_seq: 2')).toEqual([
      'required_seen_seq: 2',
    ])
    expect(payload).toContain('use `--seen 2`')
    expect(payload).toContain('team messages --dispatch d1')
  })

  test('omits required_seen_seq for orchestrator recipients', () => {
    const payload = buildDispatchMessagePayload(message({ recipientAgentId: 'ws:orchestrator' }), 2)
    expect(payload).not.toContain('required_seen_seq:')
    expect(payload).not.toContain('--seen 2')
    expect(payload).toContain('please also cover logout')
  })

  test('carries required_seen_seq on questions to workers', () => {
    const payload = buildDispatchMessagePayload(message({ kind: 'question', sequence: 3 }), 3)
    expect(payload).toContain('required_seen_seq: 3')
    expect(payload).toContain('use `--seen 3`')
  })
})
