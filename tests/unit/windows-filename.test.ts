import { describe, expect, test } from 'vitest'

import { getWindowsFilenameError } from '../../src/server/windows-filename.js'

describe('Windows-safe workflow filenames', () => {
  test('accepts normal script filenames', () => {
    expect(getWindowsFilenameError('nightly-audit.ts')).toBeUndefined()
    expect(getWindowsFilenameError('agent_1.workflow.ts')).toBeUndefined()
  })

  test('rejects reserved device names even with an extension', () => {
    expect(getWindowsFilenameError('NUL.ts')).toMatch(/reserved Windows device name/i)
    expect(getWindowsFilenameError('con.workflow.ts')).toMatch(/reserved Windows device name/i)
    expect(getWindowsFilenameError('COM1.ts')).toMatch(/reserved Windows device name/i)
    expect(getWindowsFilenameError('LPT9.ts')).toMatch(/reserved Windows device name/i)
  })

  test('rejects invalid characters and trailing dots/spaces', () => {
    expect(getWindowsFilenameError('child/name.ts')).toMatch(/characters Windows cannot create/i)
    expect(getWindowsFilenameError('child?.ts')).toMatch(/characters Windows cannot create/i)
    expect(getWindowsFilenameError('child.ts.')).toMatch(/space or period/i)
    expect(getWindowsFilenameError('child.ts ')).toMatch(/space or period/i)
  })
})
