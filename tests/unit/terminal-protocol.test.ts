import { describe, expect, test } from 'vitest'

import { parseTerminalControlMessage } from '../../src/server/terminal-protocol.js'

describe('terminal control protocol', () => {
  test('accepts positive resize dimensions', () => {
    expect(
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    ).toEqual({ type: 'resize', cols: 120, rows: 40 })
  })

  test('rejects zero or negative resize dimensions before they reach node-pty', () => {
    expect(() =>
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }))
    ).toThrow('Invalid terminal control message')
    expect(() =>
      parseTerminalControlMessage(JSON.stringify({ type: 'resize', cols: 120, rows: -1 }))
    ).toThrow('Invalid terminal control message')
  })

  test('drops negative pixel dimensions while keeping the character resize', () => {
    expect(
      parseTerminalControlMessage(
        JSON.stringify({ type: 'resize', cols: 120, rows: 40, pixelWidth: -1, pixelHeight: 900 })
      )
    ).toEqual({ type: 'resize', cols: 120, rows: 40, pixelHeight: 900 })
  })
})
