import { describe, expect, test } from 'vitest'

import { buildAgentPtySpawnOptions, createSpawnEnv } from '../../src/server/agent-manager.js'

describe('agent PTY spawn options', () => {
  test('uses explicit initial PTY dimensions and ConPTY on Windows', () => {
    const options = buildAgentPtySpawnOptions('C:\\repo', { PATH: 'C:\\bin' }, 'win32')

    expect(options).toMatchObject({
      cols: 80,
      cwd: 'C:\\repo',
      env: { PATH: 'C:\\bin' },
      name: 'xterm-256color',
      rows: 24,
      useConpty: true,
    })
  })

  test('keeps POSIX PTY options free of Windows-only ConPTY flags', () => {
    const options = buildAgentPtySpawnOptions('/repo', { PATH: '/bin' }, 'linux')

    expect(options).toMatchObject({
      cols: 80,
      cwd: '/repo',
      env: { PATH: '/bin' },
      name: 'xterm-256color',
      rows: 24,
    })
    expect(options.useConpty).toBeUndefined()
  })

  test('merges Windows env overrides without duplicate PATH casing', () => {
    const env = createSpawnEnv({ PATH: 'C:\\fake-bin;C:\\Windows', EXTRA: undefined }, 'win32', {
      Path: 'C:\\Windows',
      KEEP: 'yes',
    })

    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
    expect(pathKeys).toEqual(['Path'])
    expect(env.Path).toBe('C:\\fake-bin;C:\\Windows')
    expect(env.KEEP).toBe('yes')
    expect(env.EXTRA).toBeUndefined()
  })
})
