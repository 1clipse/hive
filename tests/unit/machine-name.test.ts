import { describe, expect, test } from 'vitest'

import { cleanMachineName } from '../../src/server/machine-name.js'

describe('cleanMachineName', () => {
  test('strips trailing .local (macOS default)', () => {
    const result = cleanMachineName('my-mac.local')
    expect(result).toBe('my-mac')
  })

  test('strips .local case-insensitively', () => {
    expect(cleanMachineName('laptop.LOCAL')).toBe('laptop')
    expect(cleanMachineName('desktop.Local')).toBe('desktop')
  })

  test('leaves names without .local unchanged', () => {
    expect(cleanMachineName('devbox')).toBe('devbox')
    expect(cleanMachineName('work-pc.example.com')).toBe('work-pc.example.com')
  })

  test('trims surrounding whitespace', () => {
    expect(cleanMachineName('  my-host  ')).toBe('my-host')
    expect(cleanMachineName('\tmy-host.local\n')).toBe('my-host')
  })

  test('returns null for empty string', () => {
    expect(cleanMachineName('')).toBeNull()
  })

  test('returns null when only whitespace remains after cleaning', () => {
    expect(cleanMachineName('   ')).toBeNull()
    expect(cleanMachineName('.local')).toBeNull()
  })

  test('caps at 64 characters', () => {
    const long = 'a'.repeat(80)
    const result = cleanMachineName(long)
    expect(result).toHaveLength(64)
    expect(result).toBe('a'.repeat(64))
  })

  test('cap is applied after stripping .local and trimming', () => {
    const long = `${'a'.repeat(70)}.local`
    const result = cleanMachineName(long)
    // .local stripped, then trimmed (no whitespace), then capped at 64
    expect(result).toBe('a'.repeat(64))
  })
})
