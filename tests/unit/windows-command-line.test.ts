import { describe, expect, test } from 'vitest'

import {
  buildCmdCallCommand,
  buildCmdCommand,
  escapeCmdToken,
} from '../../src/server/windows-command-line.js'

describe('Windows cmd command-line escaping', () => {
  test('leaves plain tokens alone', () => {
    expect(escapeCmdToken('npm.cmd')).toBe('npm.cmd')
  })

  test('quotes whitespace and cmd metacharacters', () => {
    expect(escapeCmdToken('C:\\Program Files\\nodejs')).toBe('"C:\\Program Files\\nodejs"')
    expect(escapeCmdToken('C:\\code\\a&b')).toBe('"C:\\code\\a&b"')
    expect(escapeCmdToken('value|next')).toBe('"value|next"')
  })

  test('doubles percent signs before cmd sees environment expansion syntax', () => {
    expect(escapeCmdToken('C:\\Users\\%USERNAME%\\hive')).toBe('"C:\\Users\\%%USERNAME%%\\hive"')
  })

  test('doubles inner quotes using cmd quote rules', () => {
    expect(escapeCmdToken('say "hi"')).toBe('"say ""hi"""')
  })

  test('builds command and call command as a single cmd.exe /c payload', () => {
    expect(buildCmdCommand('npm.cmd', ['install', 'C:\\Program Files\\pkg'])).toBe(
      'npm.cmd install "C:\\Program Files\\pkg"'
    )
    expect(buildCmdCallCommand('npm.cmd', ['x&y'])).toBe('call npm.cmd "x&y"')
  })
})
