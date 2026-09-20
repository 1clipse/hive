import { describe, expect, test } from 'vitest'

import { PACKAGE_NAME, readPackageVersion } from '../../src/server/package-version.js'
import { createVersionService } from '../../src/server/version-service.js'

const updatePlan = {
  canRunHiveUpdate: false,
  installArgs: [],
  installCommand: 'pnpm add -g @tt-a1i/hive@latest',
  installSource: 'pnpm-global' as const,
  manualCommand: 'pnpm add -g @tt-a1i/hive@latest',
  note: 'Use pnpm so npm does not create a shadow global install.',
}

describe('version service', () => {
  test('threads the install planner into the version payload', async () => {
    const service = createVersionService({
      createUpdateInstallPlan: () => updatePlan,
      fetchLatestVersion: async () => '9.9.9',
      now: () => 10,
    })

    await expect(service.getVersionInfo()).resolves.toEqual({
      can_run_hive_update: false,
      current_version: readPackageVersion(),
      install_hint: 'pnpm add -g @tt-a1i/hive@latest',
      install_source: 'pnpm-global',
      latest_version: '9.9.9',
      package_name: PACKAGE_NAME,
      release_url: `https://www.npmjs.com/package/${PACKAGE_NAME}/v/9.9.9`,
      update_available: true,
      update_note: 'Use pnpm so npm does not create a shadow global install.',
    })
  })

  test('uses the planner fields even when registry lookup falls back to current version', async () => {
    const service = createVersionService({
      createUpdateInstallPlan: () => updatePlan,
      fetchLatestVersion: async () => {
        throw new Error('offline')
      },
      now: () => 10,
    })

    await expect(service.getVersionInfo()).resolves.toMatchObject({
      can_run_hive_update: false,
      install_hint: 'pnpm add -g @tt-a1i/hive@latest',
      install_source: 'pnpm-global',
      latest_version: readPackageVersion(),
      update_available: false,
      update_note: 'Use pnpm so npm does not create a shadow global install.',
    })
  })

  test('keeps unknown install source non-executable in the version payload', async () => {
    const service = createVersionService({
      createUpdateInstallPlan: () => ({
        canRunHiveUpdate: false,
        installArgs: [],
        installCommand: '',
        installSource: 'unknown',
        manualCommand: '',
        note: 'Hive could not determine how this process was installed.',
      }),
      fetchLatestVersion: async () => '9.9.9',
      now: () => 10,
    })

    await expect(service.getVersionInfo()).resolves.toMatchObject({
      can_run_hive_update: false,
      install_hint: '',
      install_source: 'unknown',
      update_available: true,
      update_note: 'Hive could not determine how this process was installed.',
    })
  })
})
