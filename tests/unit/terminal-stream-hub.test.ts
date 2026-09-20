import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, test, vi } from 'vitest'
import type WebSocket from 'ws'

import type { RuntimeStore } from '../../src/server/runtime-store.js'
import { createTerminalStreamHub } from '../../src/server/terminal-stream-hub.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  bufferedAmount = 0
  readyState = 1
  sent: string[] = []

  send(payload: string) {
    this.sent.push(payload)
  }

  terminate() {
    this.readyState = 3
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal stream hub', () => {
  test('established io websocket errors are logged instead of becoming uncaught EventEmitter errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new FakeSocket()
    const store = {
      getLiveRun: () => ({
        agentId: 'agent-1',
        exitCode: null,
        output: '',
        pid: 1,
        runId: 'run-1',
        startedAt: Date.now(),
        status: 'running',
      }),
      getPtyOutputBus: () => ({ subscribe: () => () => {} }),
      pauseTerminalRun: vi.fn(),
      resumeTerminalRun: vi.fn(),
      writeRunInput: vi.fn(),
    } as unknown as RuntimeStore
    const hub = createTerminalStreamHub(store)
    const error = new RangeError('Invalid WebSocket frame: RSV2 and RSV3 must be clear')

    hub.attachIo('run-1', 'client-1', socket as unknown as WebSocket)

    expect(socket.listenerCount('error')).toBe(1)
    socket.emit('error', error)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('terminal run-1 io websocket error'),
      error
    )
    hub.close()
  })

  test('io input write failures are reported without escaping the websocket event', () => {
    const socket = new FakeSocket()
    const store = {
      getLiveRun: () => ({
        agentId: 'agent-1',
        exitCode: null,
        output: '',
        pid: 1,
        runId: 'run-1',
        startedAt: Date.now(),
        status: 'running',
      }),
      getPtyOutputBus: () => ({ subscribe: () => () => {} }),
      pauseTerminalRun: vi.fn(),
      resumeTerminalRun: vi.fn(),
      writeRunInput: vi.fn(() => {
        throw new Error('Run not found: run-1')
      }),
    } as unknown as RuntimeStore
    const hub = createTerminalStreamHub(store)

    hub.attachIo('run-1', 'client-1', socket as unknown as WebSocket)

    socket.emit('message', Buffer.from('x'), false)
    expect(JSON.parse(socket.sent.at(-1) ?? '')).toEqual({
      type: 'error',
      message: 'Run not found: run-1',
    })
    hub.close()
  })
})
