import { execFile } from 'node:child_process'
import { mkdir, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const WORKFLOW_WORKTREE_BRANCH_MAX_LEN = 80
const FALLBACK_BRANCH = 'hive/wf-worktree'

export interface WorkflowWorktreeHandle {
  base: string
  branch: string
  dir: string
  workspacePath: string
}

export interface WorkflowWorktreeCleanupResult {
  base: string
  branch: string
  kept: boolean
  path?: string
}

const execGit = async (args: readonly string[], cwd: string) => {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })
  return stdout.trim()
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const branchExists = async (branch: string, cwd: string): Promise<boolean> =>
  execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
    .then(() => true)
    .catch(() => false)

const sanitizeComponent = (raw: string): string => {
  let part = raw
  while (part.includes('..')) part = part.replaceAll('..', '.')
  part = part.replace(/^\.+/u, '').replace(/^-+/u, '')
  part = part.replace(/\.lock$/iu, '')
  part = part.replace(/\.+$/u, '')
  part = part.replace(/^-+/u, '')
  return part
}

const sanitizeOnce = (raw: string): string => {
  const replaced = [...raw]
    .map((ch) => {
      const code = ch.charCodeAt(0)
      if (code < 32 || code === 127) return '-'
      if (!/[A-Za-z0-9._/-]/u.test(ch)) return '-'
      return ch
    })
    .join('')
    .replace(/\/{2,}/gu, '/')
  const parts = replaced
    .split('/')
    .map(sanitizeComponent)
    .filter((part) => part.length > 0)
  let result = parts.join('/')
  if (result.length > WORKFLOW_WORKTREE_BRANCH_MAX_LEN) {
    result = result.slice(0, WORKFLOW_WORKTREE_BRANCH_MAX_LEN).replace(/[-./]+$/u, '')
    result = result
      .split('/')
      .map(sanitizeComponent)
      .filter((part) => part.length > 0)
      .join('/')
  }
  if (!result.includes('/')) result = result ? `hive/${result}` : FALLBACK_BRANCH
  result = result.replace(/^[-.]+/u, '').replace(/[-.]+$/u, '')
  if (
    !result.includes('/') ||
    result.includes('..') ||
    result.endsWith('.lock') ||
    result.startsWith('-') ||
    result.startsWith('.') ||
    result.endsWith('.') ||
    result.includes('@{') ||
    /\/\./u.test(result)
  ) {
    return FALLBACK_BRANCH
  }
  return result || FALLBACK_BRANCH
}

/** Sanitize a git branch name so it passes `git check-ref-format --branch`. */
export const sanitizeWorkflowWorktreeBranch = (raw: string): string => sanitizeOnce(raw)

export const buildWorkflowWorktreeBranch = (input: {
  label: string
  runId: string
  step: number
}): string => {
  const runShort = input.runId.replaceAll('-', '').slice(0, 8)
  return sanitizeWorkflowWorktreeBranch(`hive/wf-${runShort}-${input.step}-${input.label}`)
}

export const workflowWorktreeRootDir = (): string => join(tmpdir(), 'hive-worktrees')

export const workflowWorktreeDir = (workspaceId: string, branch: string): string =>
  join(workflowWorktreeRootDir(), workspaceId, branch.replaceAll('/', '-'))

export const isWorkflowWorktreeDir = (cwd: string): boolean => {
  const root = resolve(workflowWorktreeRootDir())
  const resolved = resolve(cwd)
  if (resolved === root) return false
  const rel = relative(root, resolved)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..'
}

export const buildWorktreeDispatchPreamble = (handle: WorkflowWorktreeHandle): string =>
  `You are working in an isolated git worktree at ${handle.dir} on branch ${handle.branch} (base ${handle.base}). Commit your work on this branch before reporting; the orchestrating script will merge. Do not touch the main checkout.\n\n`

export const formatWorkflowWorktreeLine = (meta: WorkflowWorktreeCleanupResult): string => {
  const escapeAttr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  return `<hive-worktree branch="${escapeAttr(meta.branch)}" base="${escapeAttr(meta.base)}" kept="${meta.kept}" path="${escapeAttr(meta.path ?? '')}"/>`
}

export const applyWorkflowWorktreeMeta = (
  result: string | Record<string, unknown>,
  meta: WorkflowWorktreeCleanupResult
): string | Record<string, unknown> => {
  if (typeof result === 'string') {
    return `${result}\n\n${formatWorkflowWorktreeLine(meta)}`
  }
  const worktree: { base: string; branch: string; kept: boolean; path?: string } = {
    base: meta.base,
    branch: meta.branch,
    kept: meta.kept,
  }
  if (meta.path) worktree.path = meta.path
  return { ...result, worktree }
}

/* Delete a branch only while it still points at the SHA we created or
   validated it at. `git branch -D` would also delete a branch a foreign
   writer committed to between our check and the delete; `update-ref -d`
   with the expected old value is a compare-and-swap, so a branch whose HEAD
   moved survives (safe direction — a kept branch is recoverable, a deleted
   one is not). */
export const deleteWorkflowWorktreeBranchIfUnchanged = async (
  branch: string,
  expectedSha: string,
  cwd: string
) => {
  try {
    await execGit(['update-ref', '-d', `refs/heads/${branch}`, expectedSha], cwd)
  } catch (error) {
    console.warn(`[hive] workflow worktree branch kept (CAS delete lost): ${branch}`, error)
  }
}

const removeEmptyWorktreeParent = async (dir: string) => {
  await rmdir(dirname(dir)).catch(() => {})
}

const removeCreatedDest = async (dir: string, workspacePath: string) => {
  await execGit(['worktree', 'remove', '--force', dir], workspacePath).catch(() => {})
  await rm(dir, { force: true, recursive: true }).catch(() => {})
  await removeEmptyWorktreeParent(dir)
}

export const createWorkflowWorktree = async (input: {
  label: string
  runId: string
  step: number
  workspaceId: string
  workspacePath: string
}): Promise<WorkflowWorktreeHandle> => {
  let inside: string
  try {
    inside = await execGit(['rev-parse', '--is-inside-work-tree'], input.workspacePath)
  } catch (error) {
    throw new Error(
      `Workflow isolation 'worktree' requires the workspace to be a git repository (${input.workspacePath}). git rev-parse --is-inside-work-tree failed.`,
      { cause: error }
    )
  }
  if (inside !== 'true') {
    throw new Error(
      `Workflow isolation 'worktree' requires the workspace to be a git repository (${input.workspacePath}). git rev-parse --is-inside-work-tree failed.`
    )
  }

  const branch = buildWorkflowWorktreeBranch({
    label: input.label,
    runId: input.runId,
    step: input.step,
  })
  const dir = workflowWorktreeDir(input.workspaceId, branch)
  const base = await execGit(['rev-parse', 'HEAD'], input.workspacePath)
  /* Atomic destination claim: a plain mkdir fails with EEXIST the instant any
     other writer created the dir, so an independently created destination can
     never be mistaken for ours and deleted (an absence checked earlier is not
     ownership). git worktree add accepts an existing empty directory. */
  await mkdir(join(dir, '..'), { recursive: true })
  try {
    await mkdir(dir)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Workflow isolation 'worktree': destination ${dir} already exists. Remove it first.`
      )
    }
    throw error
  }
  try {
    await execGit(['branch', branch, base], input.workspacePath)
  } catch (error) {
    // The dir is our own empty claim — safe to remove before surfacing.
    await rm(dir, { force: true, recursive: true }).catch(() => {})
    await removeEmptyWorktreeParent(dir)
    if (await branchExists(branch, input.workspacePath)) {
      throw new Error(
        `Workflow isolation 'worktree': branch ${branch} already exists in ${input.workspacePath}. Merge or delete it first.`
      )
    }
    throw error
  }
  try {
    await execGit(['worktree', 'add', dir, branch], input.workspacePath)
  } catch (error) {
    // The branch delete is a CAS on the base SHA: a foreign commit landing
    // on the branch between create and this failure keeps it. The dir was
    // atomically claimed empty by us, so removing it can only delete our
    // own (or git's partial) content.
    await deleteWorkflowWorktreeBranchIfUnchanged(branch, base, input.workspacePath)
    await removeCreatedDest(dir, input.workspacePath)
    throw error
  }
  return { base, branch, dir, workspacePath: input.workspacePath }
}

/* The member's PTY is stopped (not awaited) right before cleanup, so for a
   few ms the dying process may still hold the worktree as its cwd, which
   makes `git worktree remove` fail on macOS. Retry briefly instead of leaking
   the directory and branch. */
const removeWorktreeDir = async (handle: WorkflowWorktreeHandle) => {
  const attempts = 10
  for (let attempt = 1; ; attempt += 1) {
    try {
      await execGit(['worktree', 'remove', '--force', handle.dir], handle.workspacePath)
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

export const cleanupWorkflowWorktree = async (
  handle: WorkflowWorktreeHandle
): Promise<WorkflowWorktreeCleanupResult> => {
  try {
    let dirty = false
    if (await pathExists(handle.dir)) {
      const porcelain = await execGit(['status', '--porcelain'], handle.dir)
      dirty = porcelain.length > 0
    }
    let uniqueCommits: number | null = 0
    let branchSha: string | null = null
    try {
      // Capture the branch SHA BEFORE the ahead-check so the later delete is
      // a CAS against a validated value: a commit landing between the check
      // and the delete keeps the branch.
      branchSha = await execGit(['rev-parse', `refs/heads/${handle.branch}`], handle.workspacePath)
      const count = await execGit(
        ['rev-list', '--count', `${handle.base}..${handle.branch}`],
        handle.workspacePath
      )
      const parsed = Number.parseInt(count, 10)
      uniqueCommits = Number.isFinite(parsed) ? parsed : null
    } catch {
      // Unknown ahead: never delete a branch that may have commits.
      uniqueCommits = null
    }
    const keepBranch = uniqueCommits === null || uniqueCommits > 0 || dirty
    let keepDir = dirty
    if (!keepDir && (await pathExists(handle.dir))) {
      await removeWorktreeDir(handle)
      await removeEmptyWorktreeParent(handle.dir)
    }
    if (!keepBranch && branchSha) {
      await deleteWorkflowWorktreeBranchIfUnchanged(handle.branch, branchSha, handle.workspacePath)
    }
    if (await pathExists(handle.dir)) keepDir = true
    return {
      base: handle.base,
      branch: handle.branch,
      kept: keepBranch || keepDir,
      ...(keepDir ? { path: handle.dir } : {}),
    }
  } catch (error) {
    console.error('[hive] swallowed:workflowWorktree.cleanup', error)
    return {
      base: handle.base,
      branch: handle.branch,
      kept: true,
      ...((await pathExists(handle.dir).catch(() => false)) ? { path: handle.dir } : {}),
    }
  }
}

export const cleanupOrphanedWorkflowWorktree = async (input: {
  cwd: string
  workspacePath: string
}): Promise<WorkflowWorktreeCleanupResult | undefined> => {
  if (!isWorkflowWorktreeDir(input.cwd)) return undefined
  let branch: string
  try {
    branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], input.cwd)
  } catch {
    return undefined
  }
  if (!branch || branch === 'HEAD') return undefined
  let base: string
  try {
    base = await execGit(['rev-parse', 'HEAD'], input.workspacePath)
  } catch {
    return undefined
  }
  const result = await cleanupWorkflowWorktree({
    base,
    branch,
    dir: input.cwd,
    workspacePath: input.workspacePath,
  })
  if (result.kept) {
    console.warn('[hive] orphan worktree kept (dirty or unknown ahead)', {
      branch: result.branch,
      path: result.path ?? input.cwd,
    })
  }
  return result
}
