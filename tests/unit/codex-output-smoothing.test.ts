import { describe, expect, test } from 'vitest'

import {
  isCodexPromptEraseInput,
  smoothCodexTerminalOutput,
} from '../../web/src/terminal/codex-output-smoothing.js'

const ESC = '\x1b'

describe('smoothCodexTerminalOutput', () => {
  test('normalizes Codex blinking cursor styles to steady cursor styles', () => {
    const result = smoothCodexTerminalOutput(`${ESC}[0 q${ESC}[1 q${ESC}[3 q${ESC}[5 qWorking`)

    expect(result.suppress).toBe(false)
    expect(result.chunk).toBe(`${ESC}[2 q${ESC}[2 q${ESC}[4 q${ESC}[6 qWorking`)
  })

  test('distills Codex cursor-only synchronized repaint frames to the final cursor position', () => {
    const result = smoothCodexTerminalOutput(
      [
        `${ESC}[61;3H${ESC}[?25h${ESC}[?2026h${ESC}[0 q${ESC}[?25l`,
        `${ESC}[59;2H${ESC}[K\r\n${ESC}[K`,
        `${ESC}[61;34H${ESC}[K${ESC}[62;2H${ESC}[K${ESC}[63;22H${ESC}[K`,
        `${ESC}[?25h${ESC}[?2026l${ESC}[?25l`,
      ].join('')
    )

    expect(result.suppress).toBe(false)
    expect(result.chunk).toBe(`${ESC}[2 q${ESC}[?25h${ESC}[63;22H`)
  })

  test('preserves Codex prompt edit repaint frames after erase input', () => {
    const repaint = [
      `${ESC}[61;3H${ESC}[?25h${ESC}[?2026h${ESC}[0 q${ESC}[?25l`,
      `${ESC}[59;2H${ESC}[K\r\n${ESC}[K${ESC}[61;34H${ESC}[K`,
      `${ESC}[?25h${ESC}[?2026l${ESC}[?25l`,
    ].join('')

    const result = smoothCodexTerminalOutput(repaint, { preservePromptEditFrame: true })

    expect(result.suppress).toBe(false)
    expect(result.consumedPromptEraseInput).toBe(true)
    expect(result.chunk).toBe(repaint.replace(`${ESC}[0 q`, `${ESC}[2 q`))
    expect(result.chunk).toContain(`${ESC}[K`)
  })

  test('recognizes Codex prompt erase input bytes', () => {
    expect(isCodexPromptEraseInput('\x7f')).toBe(true)
    expect(isCodexPromptEraseInput('\b')).toBe(true)
    expect(isCodexPromptEraseInput('\x15')).toBe(true)
    expect(isCodexPromptEraseInput('\x17')).toBe(true)
    expect(isCodexPromptEraseInput(`${ESC}[3~`)).toBe(true)
    expect(isCodexPromptEraseInput(`${ESC}[D`)).toBe(false)
    expect(isCodexPromptEraseInput('abc')).toBe(false)
  })

  test('keeps Codex cursor movement frames produced by left and right arrows', () => {
    const result = smoothCodexTerminalOutput(
      `${ESC}[?2026h${ESC}[11;2H${ESC}[0m${ESC}[m${ESC}[K${ESC}[13;6H${ESC}[0m${ESC}[m${ESC}[K${ESC}[0 q${ESC}[?25h${ESC}[13;5H${ESC}[?2026l`
    )

    expect(result.suppress).toBe(false)
    expect(result.chunk).toBe(`${ESC}[2 q${ESC}[?25h${ESC}[13;5H`)
  })

  test('keeps Codex synchronized frames that contain visible text', () => {
    const result = smoothCodexTerminalOutput(
      `${ESC}[?2026h${ESC}[?25l${ESC}[2KWorking (25s)${ESC}[?2026l`
    )

    expect(result.suppress).toBe(false)
    expect(result.chunk).toContain('Working (25s)')
  })

  test('keeps control-only chunks that are not Codex cursor repaint frames', () => {
    const result = smoothCodexTerminalOutput(`${ESC}[2J${ESC}[H`)

    expect(result.suppress).toBe(false)
    expect(result.chunk).toBe(`${ESC}[2J${ESC}[H`)
  })
})
