import { describe, expect, test } from 'vitest'

import {
  classifyCompletedRunStatus,
  isUserInterruptExitCode,
  shouldClearResumedSessionOnExit,
  WINDOWS_CONTROL_C_EXIT_CODE,
} from '../../src/server/agent-exit-classification.js'

describe('agent exit classification', () => {
  test('treats Windows Ctrl-C as a clean user interrupt, not a crash', () => {
    expect(isUserInterruptExitCode(WINDOWS_CONTROL_C_EXIT_CODE)).toBe(true)
    expect(classifyCompletedRunStatus(WINDOWS_CONTROL_C_EXIT_CODE)).toBe('exited')
    expect(shouldClearResumedSessionOnExit(WINDOWS_CONTROL_C_EXIT_CODE)).toBe(false)
  })

  test('still treats ordinary non-zero exits as failures', () => {
    expect(isUserInterruptExitCode(1)).toBe(false)
    expect(classifyCompletedRunStatus(1)).toBe('error')
    expect(shouldClearResumedSessionOnExit(1)).toBe(true)
  })
})
