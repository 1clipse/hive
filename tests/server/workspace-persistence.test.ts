import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore, type RuntimeStore } from '../../src/server/runtime-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []
const stores: RuntimeStore[] = []

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()?.close()
  }
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

describe('workspace persistence', () => {
  test('reloads workspaces from sqlite-backed storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hive-store-'))
    tempDirs.push(tempDir)

    const firstStore = createRuntimeStore({ dataDir: tempDir })
    stores.push(firstStore)
    firstStore.createWorkspace('/tmp/hive-alpha', 'Alpha')
    firstStore.createWorkspace('/tmp/hive-beta', 'Beta')

    const secondStore = createRuntimeStore({ dataDir: tempDir })
    stores.push(secondStore)

    expect(secondStore.listWorkspaces()).toEqual([
      {
        id: expect.any(String),
        name: 'Alpha',
        path: '/tmp/hive-alpha',
      },
      {
        id: expect.any(String),
        name: 'Beta',
        path: '/tmp/hive-beta',
      },
    ])
  })
})
