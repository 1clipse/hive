import { describe, expect, test } from 'vitest'

import {
  DreamRunValidationError,
  parseDreamOperations,
} from '../../src/server/team-memory-dream-ops.js'

describe('parseDreamOperations', () => {
  test('requires procedure_ref payload for procedure_ref add ops', () => {
    expect(() =>
      parseDreamOperations([
        {
          body: 'Use the release workflow.',
          kind: 'procedure_ref',
          op: 'add',
        },
      ])
    ).toThrow(DreamRunValidationError)
  })

  test('accepts structured procedure_ref add ops', () => {
    expect(
      parseDreamOperations([
        {
          body: 'Use the release workflow.',
          kind: 'procedure_ref',
          op: 'add',
          procedure_ref: { id: 'release', title: 'Release', type: 'workflow' },
        },
      ])
    ).toEqual([
      expect.objectContaining({
        kind: 'procedure_ref',
        procedureRef: { id: 'release', title: 'Release', type: 'workflow' },
      }),
    ])
  })
})
