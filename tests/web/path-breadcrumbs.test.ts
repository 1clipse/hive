import { describe, expect, test } from 'vitest'

import { WINDOWS_DRIVES_ROOT } from '../../src/shared/fs-browse.js'
import { buildBreadcrumbs } from '../../web/src/workspace/path-breadcrumbs.js'

describe('buildBreadcrumbs', () => {
  test('handles Windows root casing differences', () => {
    expect(buildBreadcrumbs('c:\\users\\me\\project', 'C:\\Users\\Me')).toEqual([
      { label: '~ (Me)', path: 'C:\\Users\\Me' },
      { label: 'project', path: 'C:\\Users\\Me\\project' },
    ])
  })

  test('does not treat same-prefix Windows siblings as children', () => {
    expect(buildBreadcrumbs('C:\\Users\\me-other', 'C:\\Users\\me')).toEqual([
      { label: '~ (me)', path: 'C:\\Users\\me' },
    ])
  })

  test('does not treat same-prefix POSIX siblings as children', () => {
    expect(buildBreadcrumbs('/Users/me-other', '/Users/me')).toEqual([
      { label: '~ (me)', path: '/Users/me' },
    ])
  })

  test('expands UNC paths under the Windows virtual drive root', () => {
    expect(
      buildBreadcrumbs('\\\\server\\share\\repo\\subdir', WINDOWS_DRIVES_ROOT, 'This PC')
    ).toEqual([
      { label: 'This PC', path: WINDOWS_DRIVES_ROOT },
      { label: '\\\\server\\share', path: '\\\\server\\share\\' },
      { label: 'repo', path: '\\\\server\\share\\repo' },
      { label: 'subdir', path: '\\\\server\\share\\repo\\subdir' },
    ])
  })

  test('treats backslash UNC roots case-insensitively', () => {
    expect(buildBreadcrumbs('\\\\SERVER\\Share\\repo', '\\\\server\\share')).toEqual([
      { label: '~ (share)', path: '\\\\server\\share' },
      { label: 'repo', path: '\\\\server\\share\\repo' },
    ])
  })
})
