import { rmSync } from 'node:fs'

const WINDOWS_RETRYABLE_REMOVE_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])

const sleepSync = (delayMs: number) => {
  if (delayMs <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

const getErrorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined

export const removeTestPath = (
  path: string,
  {
    maxRetries = 100,
    retryDelayMs = 100,
  }: {
    maxRetries?: number
    retryDelayMs?: number
  } = {}
) => {
  let attempt = 0
  while (true) {
    try {
      rmSync(path, { force: true, recursive: true })
      return
    } catch (error) {
      const canRetry =
        process.platform === 'win32' &&
        WINDOWS_RETRYABLE_REMOVE_ERRORS.has(getErrorCode(error) ?? '') &&
        attempt < maxRetries
      if (!canRetry) throw error
      attempt += 1
      sleepSync(retryDelayMs)
    }
  }
}
