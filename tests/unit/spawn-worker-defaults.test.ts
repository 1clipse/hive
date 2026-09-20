import { describe, expect, test } from 'vitest'

import { resolveSpawnWorkerDefaults } from '../../src/server/spawn-worker-defaults.js'

const UUID_SUFFIX = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('resolveSpawnWorkerDefaults', () => {
  test('spawn-then-send-by-role: unknown role keeps its label as the worker name', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(),
    })
    // `team send researcher` matches name exactly — the bare label must win.
    expect(result.name).toBe('researcher')
    expect(result.role).toBe('custom')
    expect(result.description).toContain('researcher')
  })

  test('unknown role descriptions follow the requested UI language', () => {
    const english = resolveSpawnWorkerDefaults({
      language: 'en',
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(),
    })
    const chinese = resolveSpawnWorkerDefaults({
      language: 'zh',
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(),
    })

    expect(english.description).toContain('You are researcher.')
    expect(english.description).toContain('team report')
    expect(english.description).not.toContain('你是')
    expect(chinese.description).toContain('你是 researcher')
    expect(chinese.description).toContain('team report')
    expect(chinese.description).not.toContain('You are')
  })

  test('removed sentinel role is rejected instead of recreated as custom', () => {
    expect(() =>
      resolveSpawnWorkerDefaults({
        requestedRole: 'sentinel',
        requestedName: undefined,
        takenNames: new Set(),
      })
    ).toThrow(/sentinel.*removed/i)
  })

  test('removed sentinel role rejection is case-insensitive', () => {
    expect(() =>
      resolveSpawnWorkerDefaults({
        requestedRole: 'Sentinel',
        requestedName: undefined,
        takenNames: new Set(),
      })
    ).toThrow(/sentinel.*removed/i)
  })

  test('unknown non-removed role still maps to custom', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(),
    })
    expect(result.role).toBe('custom')
  })

  test('built-in role with no name defaults to the bare role string', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'reviewer',
      requestedName: undefined,
      takenNames: new Set(['coder', 'tester']),
    })
    expect(result.name).toBe('reviewer')
    expect(result.role).toBe('reviewer')
    // Built-in roles keep the store's default role description.
    expect(result.description).toBeUndefined()
  })

  test('falls back to label-uuid when the bare label is already taken', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(['researcher']),
    })
    expect(result.name).toMatch(/^researcher-/)
    expect(result.name).toMatch(UUID_SUFFIX)
    expect(result.role).toBe('custom')
  })

  test('explicit name always wins, trimmed, regardless of roster', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'coder',
      requestedName: '  verify-1  ',
      takenNames: new Set(['coder', 'verify-1']),
    })
    // Collisions on explicit names stay the store's job (ConflictError → 409).
    expect(result.name).toBe('verify-1')
    expect(result.role).toBe('coder')
  })

  test('missing or blank role falls back to coder', () => {
    for (const requestedRole of [undefined, '', '   ']) {
      const result = resolveSpawnWorkerDefaults({
        requestedRole,
        requestedName: undefined,
        takenNames: new Set(),
      })
      expect(result.role).toBe('coder')
      expect(result.name).toBe('coder')
      expect(result.description).toBeUndefined()
    }
  })

  test('explicit custom role keeps the generic custom description', () => {
    const result = resolveSpawnWorkerDefaults({
      requestedRole: 'custom',
      requestedName: undefined,
      takenNames: new Set(),
    })
    expect(result.role).toBe('custom')
    expect(result.name).toBe('custom')
    expect(result.description).toBeUndefined()
  })

  test('reserved pseudo-agent labels never become bare worker names', () => {
    for (const requestedRole of ['orchestrator', 'Workflow']) {
      const result = resolveSpawnWorkerDefaults({
        requestedRole,
        requestedName: undefined,
        takenNames: new Set(),
      })
      expect(result.name).not.toBe(requestedRole)
      expect(result.name.startsWith(requestedRole)).toBe(true)
      expect(result.name).toMatch(UUID_SUFFIX)
      expect(result.role).toBe('custom')
    }
  })

  test('uuid fallback stays within the store 64-char name cap', () => {
    const longLabel = 'a'.repeat(80)
    const collision = resolveSpawnWorkerDefaults({
      requestedRole: 'a'.repeat(40),
      requestedName: undefined,
      takenNames: new Set(['a'.repeat(40)]),
    })
    expect(collision.name.length).toBeLessThanOrEqual(64)
    expect(collision.name).toMatch(UUID_SUFFIX)

    // A label over the cap can never be a bare name even with no collision.
    const oversized = resolveSpawnWorkerDefaults({
      requestedRole: longLabel,
      requestedName: undefined,
      takenNames: new Set(),
    })
    expect(oversized.name.length).toBeLessThanOrEqual(64)
    expect(oversized.name).toMatch(UUID_SUFFIX)
  })

  test('two spawns of the same unknown role yield distinct addressable names', () => {
    const first = resolveSpawnWorkerDefaults({
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set(),
    })
    const second = resolveSpawnWorkerDefaults({
      requestedRole: 'researcher',
      requestedName: undefined,
      takenNames: new Set([first.name]),
    })
    expect(first.name).toBe('researcher')
    expect(second.name).not.toBe(first.name)
    expect(second.name).toMatch(/^researcher-/)
  })
})
