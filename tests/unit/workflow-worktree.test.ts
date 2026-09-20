import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  buildWorkflowWorktreeBranch,
  cleanupWorkflowWorktree,
  createWorkflowWorktree,
  sanitizeWorkflowWorktreeBranch,
  WORKFLOW_WORKTREE_BRANCH_MAX_LEN,
} from '../../src/server/workflow-worktree.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const assertValidBranch = (name: string) => {
  execFileSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' })
}

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const initRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-branch-'))
  tempDirs.push(dir)
  git(['init'], dir)
  git(['config', 'user.email', 'hive-worktree@test.local'], dir)
  git(['config', 'user.name', 'hive-worktree-test'], dir)
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(['add', 'README.md'], dir)
  git(['commit', '-m', 'init'], dir)
  return dir
}

describe('sanitizeWorkflowWorktreeBranch', () => {
  test('keeps allowed characters and replaces the rest', () => {
    expect(sanitizeWorkflowWorktreeBranch('hive/wf-abc.def_1')).toBe('hive/wf-abc.def_1')
    expect(sanitizeWorkflowWorktreeBranch('hive/wf foo@bar!')).toBe('hive/wf-foo-bar')
  })

  test('collapses slashes, trims edges, and caps length', () => {
    expect(sanitizeWorkflowWorktreeBranch('///hive//wf///')).toBe('hive/wf')
    const long = `hive/wf-${'x'.repeat(200)}`
    const sanitized = sanitizeWorkflowWorktreeBranch(long)
    expect(sanitized.length).toBeLessThanOrEqual(WORKFLOW_WORKTREE_BRANCH_MAX_LEN)
    expect(sanitized.startsWith('hive/wf-')).toBe(true)
    expect(sanitized).not.toMatch(/[^A-Za-z0-9._/-]/)
  })

  test('falls back when every character is stripped', () => {
    expect(sanitizeWorkflowWorktreeBranch('@@@')).toBe('hive/wf-worktree')
  })

  test('rejects git-invalid forms and still passes check-ref-format --branch', () => {
    const cases = [
      'hive/wf-foo..bar',
      'hive/wf-foo.lock',
      'hive/wf-foo/.bar',
      '.hidden/name',
      '-dash/name',
      'hive/wf-foo.',
      'hive/wf-foo@{bar',
      `hive/wf-${String.fromCharCode(7)}ctrl`,
    ]
    for (const raw of cases) {
      const sanitized = sanitizeWorkflowWorktreeBranch(raw)
      expect(sanitized.includes('..')).toBe(false)
      expect(sanitized.endsWith('.lock')).toBe(false)
      expect(sanitized.includes('/.')).toBe(false)
      expect(sanitized.startsWith('.')).toBe(false)
      expect(sanitized.startsWith('-')).toBe(false)
      expect(sanitized.endsWith('.')).toBe(false)
      expect(sanitized.includes('@{')).toBe(false)
      assertValidBranch(sanitized)
    }
  })
})

describe('buildWorkflowWorktreeBranch', () => {
  test('uses a short run id, step, and sanitized label', () => {
    expect(
      buildWorkflowWorktreeBranch({
        label: 'iso review!',
        runId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
        step: 3,
      })
    ).toBe('hive/wf-a1b2c3d4-3-iso-review')
  })
})

describe('createWorkflowWorktree / cleanupWorkflowWorktree', () => {
  test('refuses a pre-existing dest without creating a hive/wf-* branch', async () => {
    const repo = initRepo()
    const handle = await createWorkflowWorktree({
      label: 'first',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      step: 1,
      workspaceId: 'ws-dest',
      workspacePath: repo,
    })
    await cleanupWorkflowWorktree(handle)
    mkdirSync(handle.dir, { recursive: true })
    const branchesBefore = git(['branch', '--list', 'hive/wf-*'], repo)
    try {
      let created = false
      try {
        await createWorkflowWorktree({
          label: 'first',
          runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          step: 1,
          workspaceId: 'ws-dest',
          workspacePath: repo,
        })
        created = true
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
      expect(created).toBe(false)
      expect(git(['branch', '--list', 'hive/wf-*'], repo)).toBe(branchesBefore)
      expect(git(['branch', '--list', handle.branch], repo)).toBe('')
    } finally {
      rmSync(handle.dir, { force: true, recursive: true })
    }
  })

  test('unknown ahead keeps the branch instead of deleting it', async () => {
    const repo = initRepo()
    const handle = await createWorkflowWorktree({
      label: 'keep',
      runId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      step: 2,
      workspaceId: 'ws-ahead',
      workspacePath: repo,
    })
    writeFileSync(join(handle.dir, 'isolated.txt'), 'commit me\n')
    git(['add', 'isolated.txt'], handle.dir)
    git(['commit', '-m', 'isolated'], handle.dir)
    const result = await cleanupWorkflowWorktree({
      ...handle,
      base: 'not-a-real-sha',
    })
    expect(result.kept).toBe(true)
    expect(git(['branch', '--list', handle.branch], repo).length).toBeGreaterThan(0)
    await cleanupWorkflowWorktree(handle)
  })

  test('stores a full SHA as the worktree base', async () => {
    const repo = initRepo()
    const handle = await createWorkflowWorktree({
      label: 'sha',
      runId: 'cccccccc-dddd-eeee-ffff-000000000000',
      step: 3,
      workspaceId: 'ws-sha',
      workspacePath: repo,
    })
    expect(handle.base).toMatch(/^[0-9a-f]{40}$/)
    await cleanupWorkflowWorktree(handle)
  })
})
