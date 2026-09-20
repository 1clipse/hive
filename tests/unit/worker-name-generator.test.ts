import { describe, expect, test, vi } from 'vitest'

import agentNamesBank from '../../src/shared/agent-names.json' with { type: 'json' }
import { generateWorkerName, WORKER_NAME_POOL } from '../../src/shared/random-worker-name.js'

describe('worker name generator', () => {
  test('candidate pool is exactly names[].name from the vendored snapshot', () => {
    const fromSnapshot = agentNamesBank.names.map((entry) => entry.name)
    expect(WORKER_NAME_POOL).toEqual(fromSnapshot)
    expect(WORKER_NAME_POOL).toHaveLength(1111)
    expect(new Set(WORKER_NAME_POOL).size).toBe(1111)
    expect(WORKER_NAME_POOL.every((name) => name.trim().length > 0)).toBe(true)
  })

  test('returns the first bank name when the draw index is zero', () => {
    expect(generateWorkerName({ nextUint32: () => 0 })).toBe(WORKER_NAME_POOL[0])
  })

  test('indexes into the shared pool', () => {
    expect(generateWorkerName({ nextUint32: () => 2 })).toBe(WORKER_NAME_POOL[2])
  })

  test('preserves spaces, dots, and original casing from the bank', () => {
    expect(WORKER_NAME_POOL).toContain('Tom Nook')
    expect(WORKER_NAME_POOL).toContain('C.C.')
    expect(WORKER_NAME_POOL).toContain('艾伦·耶格尔')
    const spaced = generateWorkerName({
      nextUint32: () => WORKER_NAME_POOL.indexOf('Tom Nook'),
    })
    expect(spaced).toBe('Tom Nook')
    expect(spaced).toContain(' ')
  })

  test('skips names already used in the workspace', () => {
    const first = WORKER_NAME_POOL[0] as string
    const second = WORKER_NAME_POOL[1] as string
    const name = generateWorkerName({
      usedNames: new Set([first]),
      nextUint32: () => 0,
    })
    expect(name).toBe(second)
  })

  test('different workspaces stay independent because callers pass their own usedNames', () => {
    const first = WORKER_NAME_POOL[0] as string
    const name = generateWorkerName({
      usedNames: new Set([WORKER_NAME_POOL[10] as string, WORKER_NAME_POOL[11] as string]),
      nextUint32: () => 0,
    })
    expect(name).toBe(first)
  })

  test('falls back to the full pool when every bank name is taken', () => {
    const name = generateWorkerName({
      usedNames: new Set(WORKER_NAME_POOL),
      nextUint32: () => 0,
    })
    expect(name).toBe(WORKER_NAME_POOL[0])
  })

  test('default draw path calls crypto.getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((values) => {
      const typed = values as Uint32Array
      typed[0] = 0
      return values
    })
    try {
      expect(generateWorkerName()).toBe(WORKER_NAME_POOL[0])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
