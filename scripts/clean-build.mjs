import { rmSync } from 'node:fs'

for (const path of ['dist', 'web/dist']) {
  rmSync(path, {
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 0,
    recursive: true,
    retryDelay: 100,
  })
}
