import type { PersistedAgentRun } from './agent-run-store.js'

export const WINDOWS_CONTROL_C_EXIT_CODE = 0xc000013a

const USER_INTERRUPT_EXIT_CODES = new Set([130, 143, WINDOWS_CONTROL_C_EXIT_CODE])

export const isUserInterruptExitCode = (exitCode: number | null): boolean =>
  exitCode !== null && USER_INTERRUPT_EXIT_CODES.has(exitCode)

export const isCleanRunExitCode = (exitCode: number | null): boolean =>
  exitCode === 0 || isUserInterruptExitCode(exitCode)

export const classifyCompletedRunStatus = (exitCode: number | null): PersistedAgentRun['status'] =>
  isCleanRunExitCode(exitCode) ? 'exited' : 'error'

export const shouldClearResumedSessionOnExit = (exitCode: number | null): boolean =>
  !isCleanRunExitCode(exitCode)
