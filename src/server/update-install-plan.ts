import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSTALL_COMMAND_ARGS, PACKAGE_NAME } from './package-version.js'

export type UpdateInstallSource =
  | 'bun-global'
  | 'bunx'
  | 'npm-global'
  | 'npm-prefix'
  | 'npx'
  | 'pnpm-dlx'
  | 'pnpm-global'
  | 'source-checkout'
  | 'unknown'
  | 'yarn-dlx'
  | 'yarn-global'

export interface UpdateInstallPlan {
  canRunHiveUpdate: boolean
  installArgs: string[]
  installCommand: string
  installSource: UpdateInstallSource
  manualCommand: string
  note: string
}

interface UpdateInstallPlanOptions {
  env?: NodeJS.ProcessEnv | undefined
  moduleUrl?: string | undefined
  platform?: NodeJS.Platform | undefined
}

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_/:=.,@+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

const windowsQuote = (value: string): string => {
  if (/^[-A-Za-z0-9_/:=.,@+\\]+$/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export const formatUpdateCommand = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): string => `${command} ${args.map(platform === 'win32' ? windowsQuote : shellQuote).join(' ')}`

const normalizePath = (value: string): string => value.replaceAll('\\', '/')

const includesPathSegment = (path: string, segment: string): boolean =>
  normalizePath(path).split('/').includes(segment)

export const findPackageRoot = (moduleUrl: string): string | undefined => {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
        if (parsed.name === PACKAGE_NAME) return dir
      } catch {
        // Keep walking. A malformed unrelated package.json should not break update planning.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export const findPrefixFromPackageRoot = (packageRoot: string): string | undefined => {
  let dir = packageRoot
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(dir) === 'node_modules') {
      const parent = dirname(dir)
      return basename(parent) === 'lib' ? dirname(parent) : parent
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export const resolveHiveUpdateInstallArgs = (moduleUrl = import.meta.url): string[] => {
  const packageRoot = findPackageRoot(moduleUrl)
  const prefix = packageRoot ? findPrefixFromPackageRoot(packageRoot) : undefined
  if (!prefix) return [...INSTALL_COMMAND_ARGS]
  return [...INSTALL_COMMAND_ARGS, '--prefix', prefix]
}

const hasHint = (
  packageRoot: string | undefined,
  env: NodeJS.ProcessEnv,
  matcher: (value: string) => boolean
): boolean => {
  const hints = [
    packageRoot,
    env._,
    env.npm_command,
    env.npm_config_user_agent,
    env.npm_execpath,
    env.npm_lifecycle_event,
  ]
  return hints.some((value) => typeof value === 'string' && matcher(normalizePath(value)))
}

const hasEnvHint = (env: NodeJS.ProcessEnv, matcher: (value: string) => boolean): boolean => {
  const hints = [
    env._,
    env.npm_command,
    env.npm_config_user_agent,
    env.npm_execpath,
    env.npm_lifecycle_event,
  ]
  return hints.some((value) => typeof value === 'string' && matcher(normalizePath(value)))
}

const isBunGlobalHint = (value: string): boolean =>
  value.includes('/.bun/install/global/') ||
  value.startsWith('bun/') ||
  value.endsWith('/bun') ||
  value.endsWith('/bun.exe')

const commandPlan = (
  source: UpdateInstallSource,
  command: string,
  args: readonly string[],
  note: string,
  platform: NodeJS.Platform
): UpdateInstallPlan => ({
  canRunHiveUpdate: false,
  installArgs: [],
  installCommand: formatUpdateCommand(command, args, platform),
  installSource: source,
  manualCommand: formatUpdateCommand(command, args, platform),
  note,
})

export const createUpdateInstallPlan = (
  options: UpdateInstallPlanOptions = {}
): UpdateInstallPlan => {
  const env = options.env ?? process.env
  const moduleUrl = options.moduleUrl ?? import.meta.url
  const platform = options.platform ?? process.platform
  const packageRoot = findPackageRoot(moduleUrl)
  const packageRootPath = packageRoot ? normalizePath(packageRoot) : ''

  if (packageRootPath.includes('/_npx/')) {
    return commandPlan(
      'npx',
      'npx',
      [`${PACKAGE_NAME}@latest`],
      'This Hive process is running from an npx cache; re-run npx with @latest instead of installing a global copy.',
      platform
    )
  }

  if (hasHint(packageRoot, env, (value) => value.includes('bunx'))) {
    return commandPlan(
      'bunx',
      'bunx',
      [`${PACKAGE_NAME}@latest`],
      'This Hive process is running from bunx; re-run bunx with @latest instead of installing a global copy.',
      platform
    )
  }

  if (
    hasHint(
      packageRoot,
      env,
      (value) => (value.includes('pnpm') && value.includes('dlx')) || value.includes('/dlx-')
    )
  ) {
    return commandPlan(
      'pnpm-dlx',
      'pnpm',
      ['dlx', `${PACKAGE_NAME}@latest`],
      'This Hive process is running from pnpm dlx; re-run pnpm dlx with @latest instead of installing a global copy.',
      platform
    )
  }

  if (hasHint(packageRoot, env, (value) => value.includes('yarn') && value.includes('dlx'))) {
    return commandPlan(
      'yarn-dlx',
      'yarn',
      ['dlx', `${PACKAGE_NAME}@latest`],
      'This Hive process is running from yarn dlx; re-run yarn dlx with @latest instead of installing a global copy.',
      platform
    )
  }

  const prefix = packageRoot ? findPrefixFromPackageRoot(packageRoot) : undefined
  if (!prefix && packageRoot && !includesPathSegment(packageRoot, 'node_modules')) {
    return commandPlan(
      'source-checkout',
      'sh',
      ['-lc', 'git pull && pnpm install && pnpm build'],
      'This Hive process is running from a source checkout; update the checkout and rebuild instead of installing a global copy.',
      platform
    )
  }

  if (
    packageRootPath.includes('/.bun/install/global/') ||
    (!prefix && hasEnvHint(env, isBunGlobalHint))
  ) {
    return commandPlan(
      'bun-global',
      'bun',
      ['add', '-g', `${PACKAGE_NAME}@latest`],
      'Hive appears to be installed through bun; update it with bun so the active binary changes.',
      platform
    )
  }

  if (
    packageRootPath.includes('/.pnpm/') ||
    (!prefix && hasEnvHint(env, (value) => value.includes('pnpm')))
  ) {
    return commandPlan(
      'pnpm-global',
      'pnpm',
      ['add', '-g', `${PACKAGE_NAME}@latest`],
      'Hive appears to be installed through pnpm; update it with pnpm so npm does not create a shadow global install.',
      platform
    )
  }

  if (
    packageRootPath.includes('/yarn/global/') ||
    packageRootPath.includes('/.config/yarn/global/') ||
    (!prefix &&
      hasEnvHint(
        env,
        (value) => value.includes('/yarn/global/') || value.includes('/.config/yarn/global/')
      ))
  ) {
    return commandPlan(
      'yarn-global',
      'yarn',
      ['global', 'add', `${PACKAGE_NAME}@latest`],
      'Hive appears to be installed through yarn; update it with yarn so npm does not create a shadow global install.',
      platform
    )
  }

  const installArgs = resolveHiveUpdateInstallArgs(moduleUrl)
  const manualCommand = formatUpdateCommand('npm', installArgs, platform)
  if (!packageRoot) {
    return {
      canRunHiveUpdate: false,
      installArgs: [],
      installCommand: '',
      installSource: 'unknown',
      manualCommand: '',
      note: 'Hive could not determine how this process was installed; update it with the same package manager and install target you originally used.',
    }
  }
  return {
    canRunHiveUpdate: true,
    installArgs,
    installCommand: 'hive update',
    installSource: prefix ? 'npm-prefix' : 'npm-global',
    manualCommand,
    note: prefix
      ? 'Hive appears to be installed through npm with a custom prefix; hive update will update that same prefix.'
      : 'Hive appears to be installed through npm; hive update will run the matching npm upgrade.',
  }
}

/** Version-locked recovery for the detected install source. Never uses @latest. */
export const buildVersionLockedInstallCommand = (
  version: string,
  plan: UpdateInstallPlan,
  platform: NodeJS.Platform = process.platform
): string => {
  const installedVersion = version.trim()
  if (!installedVersion || installedVersion === 'unknown') return ''
  const spec = `${PACKAGE_NAME}@${installedVersion}`
  switch (plan.installSource) {
    case 'pnpm-global':
      return formatUpdateCommand('pnpm', ['add', '-g', spec], platform)
    case 'yarn-global':
      return formatUpdateCommand('yarn', ['global', 'add', spec], platform)
    case 'bun-global':
      return formatUpdateCommand('bun', ['add', '-g', spec], platform)
    case 'npx':
      return formatUpdateCommand('npx', ['--ignore-scripts', '--', spec], platform)
    case 'bunx':
      return formatUpdateCommand('bunx', [spec], platform)
    case 'pnpm-dlx':
      return formatUpdateCommand('pnpm', ['dlx', spec], platform)
    case 'yarn-dlx':
      return formatUpdateCommand('yarn', ['dlx', spec], platform)
    case 'source-checkout':
      return ''
    case 'npm-global':
    case 'npm-prefix': {
      const args = ['install', '-g', spec, '--ignore-scripts']
      const prefixIndex = plan.installArgs.indexOf('--prefix')
      const prefix = prefixIndex >= 0 ? plan.installArgs[prefixIndex + 1] : undefined
      if (prefix) args.push('--prefix', prefix)
      return formatUpdateCommand('npm', args, platform)
    }
    case 'unknown':
      return ''
  }
}
