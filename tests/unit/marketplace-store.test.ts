import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { loadManifest, readAgent } from '../../src/server/marketplace-store.js'

const tempDirs: string[] = []

afterEach(() => {
  delete process.env.HIVE_MARKETPLACE_VENDOR_ROOT
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createVendorRoot = () => {
  const vendorRoot = mkdtempSync(join(tmpdir(), 'hive-marketplace-store-'))
  tempDirs.push(vendorRoot)
  mkdirSync(join(vendorRoot, 'en', 'engineering'), { recursive: true })
  return vendorRoot
}

const writeManifest = (vendorRoot: string, agentName: string) => {
  writeFileSync(
    join(vendorRoot, 'en', 'manifest.json'),
    JSON.stringify({
      source: { repo: 'example/agents', commit: agentName, fetched_at: '2026-05-23T00:00:00Z' },
      language: 'en',
      categories: ['engineering'],
      agents: [
        {
          path: 'engineering/agent.md',
          category: 'engineering',
          name: agentName,
          description: `${agentName} description`,
          emoji: null,
          color: null,
          vibe: null,
        },
      ],
    })
  )
}

const writeAgent = (vendorRoot: string, body: string) => {
  const filePath = join(vendorRoot, 'en', 'engineering', 'agent.md')
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `---\nname: Agent\n---\n${body}`)
  return filePath
}

describe('marketplace-store cache', () => {
  test('caches manifests for the same vendor root but isolates different roots', () => {
    const firstRoot = createVendorRoot()
    writeManifest(firstRoot, 'First Agent')
    process.env.HIVE_MARKETPLACE_VENDOR_ROOT = firstRoot

    expect(loadManifest('en').agents[0]?.name).toBe('First Agent')
    writeManifest(firstRoot, 'Changed Agent')
    expect(loadManifest('en').agents[0]?.name).toBe('First Agent')

    const secondRoot = createVendorRoot()
    writeManifest(secondRoot, 'Second Agent')
    process.env.HIVE_MARKETPLACE_VENDOR_ROOT = secondRoot

    expect(loadManifest('en').agents[0]?.name).toBe('Second Agent')
  })

  test('caches parsed agent details for the same vendor root', () => {
    const vendorRoot = createVendorRoot()
    writeAgent(vendorRoot, 'Original body.')
    process.env.HIVE_MARKETPLACE_VENDOR_ROOT = vendorRoot

    expect(readAgent('en', 'engineering/agent.md').body.trim()).toBe('Original body.')
    writeAgent(vendorRoot, 'Changed body.')

    expect(readAgent('en', 'engineering/agent.md').body.trim()).toBe('Original body.')
  })

  test('checks the backing agent path before returning cached details', () => {
    const vendorRoot = createVendorRoot()
    const filePath = writeAgent(vendorRoot, 'Original body.')
    process.env.HIVE_MARKETPLACE_VENDOR_ROOT = vendorRoot

    expect(readAgent('en', 'engineering/agent.md').body.trim()).toBe('Original body.')
    rmSync(filePath)

    expect(() => readAgent('en', 'engineering/agent.md')).toThrow('Marketplace agent not found')
  })
})
