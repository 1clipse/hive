const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)

const CSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu')
const OSC_PATTERN = new RegExp(`${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, 'gu')
const CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'gu'
)
const BLINKING_CURSOR_STYLE_PATTERN = new RegExp(`${ESCAPE}\\[([0135]) q`, 'gu')
const BLINKING_CURSOR_STYLE_TEST_PATTERN = new RegExp(`${ESCAPE}\\[[0135] q`, 'u')
const STEADY_CURSOR_STYLE_PATTERN = new RegExp(`${ESCAPE}\\[[246] q`, 'gu')
const ERASE_LINE_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*K`, 'u')
const CURSOR_BACKWARD_PATTERN = new RegExp(`${ESCAPE}\\[[0-9]*D`, 'u')
const CURSOR_POSITION_PATTERN = new RegExp(`${ESCAPE}\\[[0-9]+(?:;[0-9]+)?[Hf]`, 'gu')
const BACKSPACE = String.fromCharCode(8)
const DELETE = String.fromCharCode(127)
const CTRL_U = String.fromCharCode(21)
const CTRL_W = String.fromCharCode(23)

const toSteadyCursorStyle = (style: string) => {
  switch (style) {
    case '3':
      return '4'
    case '5':
      return '6'
    default:
      return '2'
  }
}

const stripTerminalControls = (chunk: string) =>
  chunk.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '').replace(CONTROL_PATTERN, '')

const hasVisibleText = (chunk: string) => stripTerminalControls(chunk).trim().length > 0

const isCodexPromptEditFrame = (chunk: string) =>
  ERASE_LINE_PATTERN.test(chunk) &&
  (CURSOR_BACKWARD_PATTERN.test(chunk) || chunk.includes(BACKSPACE) || chunk.includes(DELETE))

const isCodexCursorOnlyRepaint = (chunk: string) =>
  !hasVisibleText(chunk) &&
  chunk.includes(`${ESCAPE}[?2026`) &&
  chunk.includes(`${ESCAPE}[?25`) &&
  BLINKING_CURSOR_STYLE_TEST_PATTERN.test(chunk) &&
  ERASE_LINE_PATTERN.test(chunk) &&
  !isCodexPromptEditFrame(chunk)

const lastMatch = (chunk: string, pattern: RegExp): string | null => {
  let latest: string | null = null
  pattern.lastIndex = 0
  for (const match of chunk.matchAll(pattern)) latest = match[0]
  return latest
}

export interface SmoothedCodexOutput {
  chunk: string
  consumedPromptEraseInput?: boolean
  suppress: boolean
}

export const isCodexPromptEraseInput = (chunk: string): boolean =>
  chunk.includes(BACKSPACE) ||
  chunk.includes(DELETE) ||
  chunk.includes(CTRL_U) ||
  chunk.includes(CTRL_W) ||
  chunk.includes(`${ESCAPE}[3~`)

export const smoothCodexTerminalOutput = (
  chunk: string,
  options: { preservePromptEditFrame?: boolean } = {}
): SmoothedCodexOutput => {
  const normalized = chunk.replace(
    BLINKING_CURSOR_STYLE_PATTERN,
    (_sequence, style: string) => `${ESCAPE}[${toSteadyCursorStyle(style)} q`
  )
  if (!isCodexCursorOnlyRepaint(chunk)) return { chunk: normalized, suppress: false }
  if (options.preservePromptEditFrame) {
    return { chunk: normalized, consumedPromptEraseInput: true, suppress: false }
  }

  const cursorPosition = lastMatch(normalized, CURSOR_POSITION_PATTERN)
  if (!cursorPosition) return { chunk: normalized, suppress: true }

  const cursorStyle = lastMatch(normalized, STEADY_CURSOR_STYLE_PATTERN) ?? ''
  return {
    chunk: `${cursorStyle}${ESCAPE}[?25h${cursorPosition}`,
    suppress: false,
  }
}
