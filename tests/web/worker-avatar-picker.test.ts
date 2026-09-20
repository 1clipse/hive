// @vitest-environment jsdom

import { describe, expect, test } from 'vitest'

import { readWorkerAvatarFile } from '../../web/src/worker/WorkerAvatarPicker.js'

const messages = {
  avatarTooLarge: 'avatar too large',
  loadFailed: 'load failed',
  notImage: 'not image',
  sourceTooLarge: 'source too large',
}

describe('WorkerAvatarPicker file validation', () => {
  test('rejects non-image files before loading', async () => {
    const file = new File(['hello'], 'avatar.txt', { type: 'text/plain' })

    await expect(readWorkerAvatarFile(file, messages)).rejects.toThrow('not image')
  })

  test('rejects oversized source images before loading', async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'avatar.png', {
      type: 'image/png',
    })

    await expect(readWorkerAvatarFile(file, messages)).rejects.toThrow('source too large')
  })
})
