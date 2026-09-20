import { describe, expect, test } from 'vitest'

import {
  detectPathSeparator,
  joinWithDetectedSeparator,
} from '../../web/src/workspace/path-join.js'

describe('detectPathSeparator', () => {
  test('POSIX absolute path returns "/"', () => {
    expect(detectPathSeparator('/Users/admin/code/hive')).toBe('/')
  })

  test('Windows backslash path returns "\\\\"', () => {
    expect(detectPathSeparator('C:\\Users\\me\\project')).toBe('\\')
  })

  test('Windows path with forward slashes returns "/"', () => {
    // npm tooling and some Node APIs normalize to forward slashes mid-path
    // even on Windows. We sniff the actual characters present rather than
    // checking the drive-letter prefix.
    expect(detectPathSeparator('C:/Users/me/project')).toBe('/')
  })

  test('mixed slashes pick the last-appearing separator', () => {
    expect(detectPathSeparator('C:\\repo/.hive')).toBe('/')
    expect(detectPathSeparator('C:/repo\\hive')).toBe('\\')
  })

  test('bare drive letter with no segments uses backslash', () => {
    expect(detectPathSeparator('C:')).toBe('\\')
  })

  test('relative POSIX path defaults to forward slash', () => {
    expect(detectPathSeparator('project')).toBe('/')
  })
})

describe('joinWithDetectedSeparator', () => {
  test('joins POSIX segments with forward slash', () => {
    expect(joinWithDetectedSeparator('/Users/admin/code/hive', '.hive', 'tasks.md')).toBe(
      '/Users/admin/code/hive/.hive/tasks.md'
    )
  })

  test('joins Windows segments with backslash and never produces mixed slashes', () => {
    // The user-visible bug: `${workspacePath}/.hive/tasks.md` was producing
    // `C:\Users\me\project/.hive/tasks.md`. Confirm the helper preserves
    // a single-style separator instead.
    expect(joinWithDetectedSeparator('C:\\Users\\me\\project', '.hive', 'tasks.md')).toBe(
      'C:\\Users\\me\\project\\.hive\\tasks.md'
    )
  })

  test('strips a trailing separator on the base before joining', () => {
    expect(joinWithDetectedSeparator('/Users/admin/code/hive/', '.hive', 'tasks.md')).toBe(
      '/Users/admin/code/hive/.hive/tasks.md'
    )
    expect(joinWithDetectedSeparator('C:\\Users\\me\\project\\', '.hive', 'tasks.md')).toBe(
      'C:\\Users\\me\\project\\.hive\\tasks.md'
    )
  })

  test('passes a single segment without doubling the separator', () => {
    expect(joinWithDetectedSeparator('/Users/admin', 'code')).toBe('/Users/admin/code')
    expect(joinWithDetectedSeparator('C:\\Users\\me', 'code')).toBe('C:\\Users\\me\\code')
  })
})
