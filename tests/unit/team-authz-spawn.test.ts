import { describe, expect, test } from 'vitest'

import { commandAllowedForRole } from '../../src/server/team-authz.js'

describe('team authz — spawn/dismiss', () => {
  test('orchestrator may spawn and dismiss', () => {
    expect(commandAllowedForRole('orchestrator', 'spawn')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'dismiss')).toBe(true)
  })

  test('workers may not spawn or dismiss', () => {
    expect(commandAllowedForRole('coder', 'spawn')).toBe(false)
    expect(commandAllowedForRole('reviewer', 'dismiss')).toBe(false)
  })

  test('memory search is shared but add and forget are orchestrator-only', () => {
    expect(commandAllowedForRole('orchestrator', 'memory_search')).toBe(true)
    expect(commandAllowedForRole('coder', 'memory_search')).toBe(true)
    expect(commandAllowedForRole('orchestrator', 'memory_add')).toBe(true)
    expect(commandAllowedForRole('coder', 'memory_add')).toBe(false)
    expect(commandAllowedForRole('orchestrator', 'memory_forget')).toBe(true)
    expect(commandAllowedForRole('coder', 'memory_forget')).toBe(false)
  })

  test('workers may inspect Dream runs but only orchestrators may apply them', () => {
    expect(commandAllowedForRole('orchestrator', 'memory_dream_show')).toBe(true)
    expect(commandAllowedForRole('coder', 'memory_dream_show')).toBe(true)
    expect(commandAllowedForRole('workflow', 'memory_dream_show')).toBe(false)
    expect(commandAllowedForRole('orchestrator', 'memory_apply')).toBe(true)
    expect(commandAllowedForRole('coder', 'memory_apply')).toBe(false)
  })

  test('the workflow pseudo-role may not spawn or dismiss', () => {
    expect(commandAllowedForRole('workflow', 'spawn')).toBe(false)
    expect(commandAllowedForRole('workflow', 'dismiss')).toBe(false)
  })
})
