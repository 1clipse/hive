/**
 * Optional, read-only task-dependency support for `.hive/tasks.md`.
 *
 * A task line may carry a trailing `[needs: #2, #5]` annotation declaring that
 * it depends on other tasks (referenced by their 1-based position among the
 * GFM task-list items). `team next` uses this to surface the tasks that are
 * currently runnable — not done, and with every dependency already checked off.
 *
 * Deliberately scoped: parsing happens here on the server only and is purely a
 * READ — Hive never auto-dispatches a runnable task and never writes the
 * annotation back into tasks.md (that file stays a human/orchestrator-edited,
 * git-mergeable artifact). The web task renderer is intentionally left
 * untouched, so the annotation just shows as literal text in the UI.
 */
export interface ParsedTaskLine {
  /** 1-based position among task-list items — the `#n` that `[needs:]` uses. */
  index: number
  done: boolean
  text: string
  needs: number[]
}

export interface RunnableTask {
  index: number
  text: string
}

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/
// GFM fence: 3+ backticks or tildes, indented up to 3 spaces. An OPENING
// fence may carry an info string (```md); a CLOSING fence must use the
// same character, be at least as long, and have nothing after it.
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const NEEDS = /\[needs:\s*([#\d,\s]+)\]\s*$/i

export const parseTasksWithDeps = (markdown: string): ParsedTaskLine[] => {
  const tasks: ParsedTaskLine[] = []
  let index = 0
  let openFence: { char: string; length: number } | null = null
  for (const line of markdown.split('\n')) {
    const fenceMatch = FENCE_LINE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      const info = (fenceMatch[2] ?? '').trim()
      if (!openFence) {
        openFence = { char: marker[0] ?? '`', length: marker.length }
      } else if (marker[0] === openFence.char && marker.length >= openFence.length && !info) {
        openFence = null
      }
      continue
    }
    if (openFence) continue
    const match = TASK_LINE.exec(line)
    if (!match) continue
    index += 1
    const done = (match[1] ?? ' ').toLowerCase() === 'x'
    let text = (match[2] ?? '').trim()
    const needs: number[] = []
    const needsMatch = NEEDS.exec(text)
    if (needsMatch) {
      for (const token of (needsMatch[1] ?? '').split(',')) {
        const parsed = Number.parseInt(token.replace('#', '').trim(), 10)
        if (Number.isInteger(parsed) && parsed > 0) needs.push(parsed)
      }
      // Drop the trailing annotation from the human-readable text.
      text = text.slice(0, needsMatch.index).trim()
    }
    tasks.push({ index, done, text, needs })
  }
  return tasks
}

/**
 * Tasks that can be worked right now: not yet done, and every `[needs:]`
 * dependency is a task that exists AND is checked off. A dependency on a
 * non-existent `#n`, or on a task that isn't done, withholds the task.
 */
export const computeRunnableTasks = (markdown: string): RunnableTask[] => {
  const tasks = parseTasksWithDeps(markdown)
  const doneByIndex = new Map(tasks.map((task) => [task.index, task.done]))
  return tasks
    .filter((task) => !task.done)
    .filter((task) => task.needs.every((dep) => doneByIndex.get(dep) === true))
    .map((task) => ({ index: task.index, text: task.text }))
}
