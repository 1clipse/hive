import { type Stats, statSync } from 'node:fs'

import { sanitizePastedPath } from '../shared/path-input.js'
import { BadRequestError } from './http-errors.js'
import { realpathNative } from './path-canonicalization.js'

export const validateWorkspacePath = (path: unknown): string => {
  if (typeof path !== 'string') {
    throw new BadRequestError('Workspace path is required')
  }

  const candidate = sanitizePastedPath(path)
  if (candidate.length === 0) {
    throw new BadRequestError('Workspace path is required')
  }
  let resolved: string
  try {
    resolved = realpathNative(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new BadRequestError(`Workspace path is not accessible: ${candidate}`)
    }
    if (code === 'ENAMETOOLONG') {
      throw new BadRequestError(`Workspace path is too long: ${candidate}`)
    }
    throw new BadRequestError(`Workspace path does not exist: ${candidate}`)
  }

  let stat: Stats
  try {
    stat = statSync(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new BadRequestError(`Workspace path is not accessible: ${candidate}`)
    }
    throw new BadRequestError(`Workspace path does not exist: ${candidate}`)
  }

  if (!stat.isDirectory()) {
    throw new BadRequestError(`Workspace path is not a directory: ${candidate}`)
  }

  return resolved
}
