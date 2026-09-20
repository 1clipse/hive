import { describe, expect, test } from 'vitest'

import { readWorkflowEnabled, serializeWorkflowEnabled } from '../../src/server/workflow-feature.js'

describe('readWorkflowEnabled (experimental gate — off by default)', () => {
  test('absent storage reads as disabled', () => {
    expect(readWorkflowEnabled(null)).toBe(false)
    expect(readWorkflowEnabled(undefined)).toBe(false)
  })

  test('only the exact string "true" enables it', () => {
    expect(readWorkflowEnabled('true')).toBe(true)
    expect(readWorkflowEnabled('false')).toBe(false)
    expect(readWorkflowEnabled('1')).toBe(false)
    expect(readWorkflowEnabled('TRUE')).toBe(false)
    expect(readWorkflowEnabled('garbage')).toBe(false)
  })

  test('round-trips through serializeWorkflowEnabled', () => {
    expect(readWorkflowEnabled(serializeWorkflowEnabled(true))).toBe(true)
    expect(readWorkflowEnabled(serializeWorkflowEnabled(false))).toBe(false)
  })
})
