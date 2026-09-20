import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

import {
  attachRawSocketErrorHandler,
  rejectWebSocketUpgrade,
} from '../../src/server/websocket-upgrade-safety.js'

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false
  failWrite = false
  writes: string[] = []

  destroy() {
    this.destroyed = true
  }

  write(payload: string) {
    if (this.failWrite) throw new Error('socket reset')
    this.writes.push(payload)
    return true
  }
}

describe('websocket upgrade safety', () => {
  test('reject writes a response and destroys the socket', () => {
    const socket = new FakeUpgradeSocket()

    rejectWebSocketUpgrade(socket as never, '401 Unauthorized')

    expect(socket.destroyed).toBe(true)
    expect(socket.writes).toEqual([expect.stringContaining('401 Unauthorized')])
  })

  test('raw socket errors are handled instead of becoming uncaught EventEmitter errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new FakeUpgradeSocket()

    attachRawSocketErrorHandler(socket as never, 'test upgrade')
    socket.emit('error', new Error('ECONNRESET'))

    expect(socket.listenerCount('error')).toBe(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('test upgrade socket error'),
      expect.any(Error)
    )
  })

  test('reject still destroys the socket if writing the HTTP rejection fails', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const socket = new FakeUpgradeSocket()
    socket.failWrite = true

    rejectWebSocketUpgrade(socket as never, '403 Forbidden')

    expect(socket.destroyed).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed to reject websocket upgrade with 403 Forbidden'),
      expect.any(Error)
    )
  })
})
