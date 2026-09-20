import { describe, expect, test } from 'vitest'

import { resolveWorkspaceShellStart } from '../../src/server/workspace-shell-runtime.js'

describe('workspace shell launch resolution', () => {
  test('uses pushd for Windows UNC workspace paths instead of spawning with a UNC cwd', () => {
    const launch = resolveWorkspaceShellStart(
      '\\\\server\\share\\project',
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        SystemRoot: 'C:\\Windows',
      },
      'win32'
    )
    expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(launch.cwd).toBe('C:\\Windows')
    expect(launch.args).toEqual(['/d', '/s', '/k', 'pushd \\\\server\\share\\project'])
  })

  test('keeps normal paths as the shell cwd', () => {
    const launch = resolveWorkspaceShellStart(
      'C:\\Users\\admin\\project',
      {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      'win32'
    )
    expect(launch.cwd).toBe('C:\\Users\\admin\\project')
    expect(launch.args).toEqual([])
  })
})
