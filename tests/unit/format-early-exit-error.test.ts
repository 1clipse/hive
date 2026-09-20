import { describe, expect, test } from 'vitest'

import { formatEarlyExitError } from '../../src/server/orchestrator-autostart.js'

describe('formatEarlyExitError', () => {
  test('POSIX shell exit 127 surfaces friendly "CLI not found in PATH"', () => {
    const message = formatEarlyExitError('claude', 127)
    expect(message).toBe('claude CLI not found in PATH')
  })

  test('Windows cmd.exe exit 9009 is also treated as "command not found"', () => {
    const message = formatEarlyExitError('claude', 9009)
    expect(message).toBe('claude CLI not found in PATH')
  })

  test('other non-zero exit codes surface the raw code, not the friendly message', () => {
    const message = formatEarlyExitError('claude', 1)
    expect(message).toBe('claude failed to start (exit 1)')
  })

  test('null exit code is reported verbatim', () => {
    const message = formatEarlyExitError('codex', null)
    expect(message).toBe('codex failed to start (exit null)')
  })
})
