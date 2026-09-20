import { describe, expect, test } from 'vitest'

import {
  buildTasksWatcherOptions,
  getTasksWatcherReadyTimeoutMs,
  TASKS_WATCHER_OPTIONS,
} from '../../src/server/tasks-file-watcher.js'

/**
 * Lock the chokidar configuration that keeps `.hive/tasks.md` watchable
 * across atomic-save editors on Windows. The reasoning is documented on
 * the constant itself; this test pins the *fields* so a future config
 * cleanup doesn't silently drop the protection.
 *
 * Atomic-save flow (VSCode, Cursor, Notepad++, Hive's own editor):
 *   1. write `<tasks.md>.tmp`
 *   2. rename `<tasks.md>.tmp` over `<tasks.md>`
 *
 * On Windows ReadDirectoryChangesW that rename detaches the watcher
 * from the file unless chokidar treats the unlink+add pair as one
 * atomic event (`atomic`) and waits for the rename to settle before
 * re-emitting (`awaitWriteFinish`). Drop either and the panel goes
 * deaf to external edits after the first save.
 */
describe('TASKS_WATCHER_OPTIONS — atomic-save protection', () => {
  test('atomic correlation window is enabled', () => {
    // `atomic: 100` (or any positive number) tells chokidar to collapse
    // an unlink+add pair within the window into a single `change`
    // event. Leaving it on `false` means an atomic rename surfaces as
    // unlink + add; downstream handlers that act on `change` would
    // miss the post-rename content. This is the only Windows-specific
    // guard that matters here — see the comment on the const itself
    // for why awaitWriteFinish was deliberately left out.
    expect(TASKS_WATCHER_OPTIONS.atomic).toBeTruthy()
    expect(typeof TASKS_WATCHER_OPTIONS.atomic).toBe('number')
    expect(TASKS_WATCHER_OPTIONS.atomic as number).toBeGreaterThan(0)
  })

  test('initial scan is skipped (no spurious "change" on startup)', () => {
    expect(TASKS_WATCHER_OPTIONS.ignoreInitial).toBe(true)
  })

  test('Windows uses polling to survive flaky ReadDirectoryChangesW handles', () => {
    const options = buildTasksWatcherOptions('C:\\Users\\admin\\project', 'win32')
    expect(options.usePolling).toBe(true)
    expect(options.interval).toBe(500)
  })

  test('Windows gives polling watchers a longer ready window under load', () => {
    expect(getTasksWatcherReadyTimeoutMs('C:\\Users\\admin\\project', 'win32')).toBe(60000)
    expect(getTasksWatcherReadyTimeoutMs('/Users/admin/project', 'darwin')).toBe(15000)
  })

  test('POSIX paths keep the native watcher backend', () => {
    const options = buildTasksWatcherOptions('/Users/admin/project', 'darwin')
    expect(options.usePolling).toBeUndefined()
  })
})
