import { describe, expect, test } from 'vitest'

import { planWorkflowDag } from '../../src/server/workflow-dag.js'

describe('planWorkflowDag', () => {
  test('returns deterministic dependency layers', () => {
    expect(
      planWorkflowDag([
        { id: 'a', deps: [] },
        { id: 'b', deps: [] },
        { id: 'merge', deps: ['a', 'b'] },
        { id: 'verify', deps: ['merge'] },
      ])
    ).toEqual({ layers: [['a', 'b'], ['merge'], ['verify']] })
  })

  test('rejects unknown dependencies before producing a plan', () => {
    expect(() => planWorkflowDag([{ id: 'merge', deps: ['missing'] }])).toThrow(
      'unknown dependency "missing"'
    )
  })

  test('rejects cycles before producing a plan', () => {
    expect(() =>
      planWorkflowDag([
        { id: 'root', deps: [] },
        { id: 'a', deps: ['b'] },
        { id: 'b', deps: ['a'] },
      ])
    ).toThrow(/cycle or unsatisfied dependencies among: a, b/)
  })
})
