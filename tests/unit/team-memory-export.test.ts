import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  createTeamMemoryExportService,
  getMemoryFilePath,
} from '../../src/server/team-memory-export.js'
import type { MemoryEntryWithSources } from '../../src/server/team-memory-store.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const waitFor = async (assertion: () => void, timeoutMs = 1000, intervalMs = 10) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

const memory = (input: Partial<MemoryEntryWithSources> & { body: string; id: string }) =>
  ({
    ...input,
    archivedAt: null,
    body: input.body,
    confidence: 1,
    createdAt: input.createdAt ?? 1,
    disabled: input.disabled ?? false,
    id: input.id,
    kind: input.kind ?? 'fact',
    lastInjectedAt: null,
    pinned: input.pinned ?? false,
    procedureRef: input.procedureRef ?? null,
    scope: input.scope ?? 'workspace',
    source: input.source ?? 'manual',
    sources: input.sources ?? [
      {
        actorAgentIdSnapshot: 'ws:orchestrator',
        actorNameSnapshot: 'Orchestrator',
        actorRoleSnapshot: 'orchestrator',
        createdAt: 1,
        excerpt: input.body,
        id: `${input.id}:source`,
        memoryId: input.id,
        sourceId: null,
        sourceSequence: null,
        sourceType: 'manual',
        textHash: null,
      },
    ],
    status: input.status ?? 'active',
    tags: input.tags ?? [],
    updatedAt: input.updatedAt ?? 1,
    workspaceId: 'ws',
  }) as MemoryEntryWithSources

describe('team memory exporter', () => {
  test('debounces scheduled writes and exports only the latest active memory snapshot', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-export-debounce-'))
    tempDirs.push(workspacePath)
    let entries: MemoryEntryWithSources[] = [
      memory({ body: 'First memory should be superseded.', id: 'memory-1' }),
    ]
    const exporter = createTeamMemoryExportService({
      debounceMs: 25,
      getWorkspacePath: () => workspacePath,
      listEntries: () => entries,
    })

    exporter.schedule('ws')
    expect(existsSync(getMemoryFilePath(workspacePath))).toBe(false)
    entries = [memory({ body: 'Second memory reaches the generated file.', id: 'memory-2' })]
    exporter.schedule('ws')

    await waitFor(() => {
      const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
      expect(content).toContain('Second memory reaches the generated file.')
      expect(content).not.toContain('First memory should be superseded.')
    })
    await exporter.close()
  })

  test('backs up a user-modified memory.md before regenerating it', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-export-backup-'))
    tempDirs.push(workspacePath)
    const entries = [memory({ body: 'Original generated memory.', id: 'memory-1' })]
    const exporter = createTeamMemoryExportService({
      debounceMs: 25,
      getWorkspacePath: () => workspacePath,
      listEntries: () => entries,
    })

    await exporter.flush('ws')
    writeFileSync(getMemoryFilePath(workspacePath), 'human edited content\n')
    entries[0] = memory({ body: 'Regenerated memory after edit.', id: 'memory-2' })

    await exporter.flush('ws')

    const content = readFileSync(getMemoryFilePath(workspacePath), 'utf8')
    expect(content).toContain('Regenerated memory after edit.')
    const backups = readdirSync(join(workspacePath, '.hive')).filter((name) =>
      name.startsWith('memory.md.backup-')
    )
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(workspacePath, '.hive', backups[0] ?? ''), 'utf8')).toBe(
      'human edited content\n'
    )
    await exporter.close()
  })

  test('does not back up an untouched generated memory.md', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-export-no-backup-'))
    tempDirs.push(workspacePath)
    const entries = [memory({ body: 'Original generated memory.', id: 'memory-1' })]
    const exporter = createTeamMemoryExportService({
      getWorkspacePath: () => workspacePath,
      listEntries: () => entries,
    })

    await exporter.flush('ws')
    entries[0] = memory({ body: 'Regenerated memory.', id: 'memory-2' })
    await exporter.flush('ws')

    const backups = readdirSync(join(workspacePath, '.hive')).filter((name) =>
      name.startsWith('memory.md.backup-')
    )
    expect(backups).toHaveLength(0)
    await exporter.close()
  })

  test('backs up edits in the generated header before regenerating it', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hive-memory-export-header-backup-'))
    tempDirs.push(workspacePath)
    const entries = [memory({ body: 'Original generated memory.', id: 'memory-1' })]
    const exporter = createTeamMemoryExportService({
      getWorkspacePath: () => workspacePath,
      listEntries: () => entries,
      now: () => 123,
    })

    await exporter.flush('ws')
    const memoryPath = getMemoryFilePath(workspacePath)
    const edited = readFileSync(memoryPath, 'utf8').replace('# Hive Memory', '# Edited Memory')
    writeFileSync(memoryPath, edited)
    entries[0] = memory({ body: 'Regenerated after header edit.', id: 'memory-2' })

    await exporter.flush('ws')

    const backups = readdirSync(join(workspacePath, '.hive')).filter((name) =>
      name.startsWith('memory.md.backup-123-')
    )
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(workspacePath, '.hive', backups[0] ?? ''), 'utf8')).toBe(edited)
    await exporter.close()
  })

  test('skips export when the workspace root no longer exists', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'hive-memory-export-missing-root-'))
    tempDirs.push(rootPath)
    const workspacePath = join(rootPath, 'missing-workspace')
    let listed = false
    const exporter = createTeamMemoryExportService({
      getWorkspacePath: () => workspacePath,
      listEntries: () => {
        listed = true
        return [memory({ body: 'Should not export.', id: 'memory-1' })]
      },
    })

    await exporter.flush('ws')

    expect(existsSync(workspacePath)).toBe(false)
    expect(listed).toBe(false)
    await exporter.close()
  })
})
