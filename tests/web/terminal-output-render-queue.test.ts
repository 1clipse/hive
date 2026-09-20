// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createTerminalOutputRenderQueue } from '../../web/src/terminal/terminal-output-render-queue.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal output render queue', () => {
  test('acks hidden output immediately and renders it after visibility returns', () => {
    let renderable = false
    const writes: string[] = []
    const acks: number[] = []
    const queue = createTerminalOutputRenderQueue({
      canRender: () => renderable,
      write: (chunk, callback) => {
        writes.push(chunk)
        callback()
      },
    })

    queue.enqueue('hidden', 6, (bytes) => acks.push(bytes))

    expect(writes).toEqual([])
    expect(acks).toEqual([6])

    renderable = true
    queue.flush()

    expect(writes).toEqual(['hidden'])
    expect(acks).toEqual([6])

    queue.dispose()
  })

  test('acks and releases the queue when xterm write never calls back', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const writes: string[] = []
    const acks: number[] = []
    const queue = createTerminalOutputRenderQueue({
      canRender: () => true,
      write: (chunk) => {
        writes.push(chunk)
      },
    })

    queue.enqueue('first', 5, (bytes) => acks.push(bytes))
    queue.enqueue('second', 6, (bytes) => acks.push(bytes))

    expect(writes).toEqual(['first'])
    expect(acks).toEqual([])

    vi.advanceTimersByTime(1000)
    expect(writes).toEqual(['first', 'second'])
    expect(acks).toEqual([5])

    vi.advanceTimersByTime(1000)
    expect(acks).toEqual([5, 6])

    queue.dispose()
  })
})
