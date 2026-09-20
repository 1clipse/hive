import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const script = resolve('scripts/ci-plan.mjs')
const roots: string[] = []
const manifest = { name: 'ci-fixture', version: '1.0.0', dependencies: { example: '1.0.0' } }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const planChange = (
  files: Record<string, string | null>,
  extraEnv: Record<string, string> = {}
) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-ci-plan-'))
  roots.push(root)
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: root, encoding: 'utf8' }
    )
  git('init', '-q')
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  for (const [file, contents] of Object.entries(files)) {
    if (contents !== null) continue
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'export {}')
  }
  git('add', '.')
  git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) {
      rmSync(join(root, file))
      continue
    }
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), contents)
  }
  git('add', '.')
  git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'change')
  return JSON.parse(
    execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', CI_FULL: 'false', CI_BASE_SHA: base, ...extraEnv },
    })
  )
}

test('documentation and gateway-only changes do not install the desktop runtime', () => {
  expect(
    planChange({ 'docs/guide.md': 'text', 'gateway/src/index.ts': 'export {}' })
  ).toMatchObject({
    code: false,
    full: false,
    native: false,
    extended: false,
    inputs: [],
  })
})

test('UI changes only need static checks and build', () => {
  expect(planChange({ 'web/src/example.tsx': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: false,
    extended: false,
    inputs: [],
  })
})

test('ordinary backend changes retain related tests plus real subprocess coverage', () => {
  expect(planChange({ 'src/server/settings-store.ts': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: false,
    inputs: [
      'src/server/settings-store.ts',
      'tests/cli/team-cli.test.ts',
      'tests/server/runtime-rehydration.test.ts',
    ],
  })
})

test.each([
  'src/server/sqlite-schema-v44.ts',
  'src/server/agent-manager.ts',
  'src/server/dispatch-ledger-store.ts',
  'src/server/remote-crypto.ts',
  'src/server/remote-pairing.ts',
  'src/server/remote-loopback-auth.ts',
  'src/server/team-authz.ts',
  'src/server/workflow-script-worker.ts',
])('high-risk %s changes keep full tests and platform validation', (file) => {
  expect(planChange({ [file]: 'export {}' })).toMatchObject({
    full: true,
    native: true,
    extended: false,
  })
})

test('a version bump keeps version consistency checks without running the compatibility matrix', () => {
  expect(
    planChange({ 'package.json': JSON.stringify({ ...manifest, version: '1.0.1' }) })
  ).toMatchObject({
    full: false,
    native: false,
    inputs: ['tests/unit/whats-new-select.test.ts'],
  })
})

test('dependency changes require full tests and native package validation', () => {
  expect(
    planChange({
      'package.json': JSON.stringify({ ...manifest, dependencies: { example: '2.0.0' } }),
    })
  ).toMatchObject({ full: true, native: true })
})

test('packaging changes trigger platform checks without unrelated full tests', () => {
  expect(planChange({ 'scripts/pack-smoke.mjs': 'export {}' })).toMatchObject({
    code: true,
    full: false,
    native: true,
  })
})

test('unclassified files fail closed to full validation', () => {
  expect(planChange({ 'new-build-config.json': '{}' })).toMatchObject({ full: true, native: true })
})

test('manual and nightly full mode selects the extended matrix even for documentation', () => {
  expect(planChange({ 'docs/a.md': 'text' }, { CI_FULL: 'true' })).toMatchObject({
    code: true,
    full: true,
    native: true,
    extended: true,
  })
})

test('missing comparison base is an error rather than silently skipping checks', () => {
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, CI_FULL: 'false', CI_BASE_SHA: '', GITHUB_OUTPUT: '' },
  })
  expect(result.status).toBe(1)
})

test('source deletions force full validation, while removed test files are not executed', () => {
  expect(planChange({ 'src/server/old-store.ts': null })).toMatchObject({
    full: true,
    native: true,
  })
  expect(planChange({ 'tests/unit/removed.test.ts': null })).toMatchObject({
    code: true,
    full: false,
    inputs: [],
  })
})

test.each([
  'scripts/ci-plan.mjs',
  'scripts/run-tests.mjs',
])('%s selects its executable regression', (file) => {
  expect(planChange({ [file]: 'export {}' })).toMatchObject({
    full: false,
    native: true,
    inputs: ['tests/unit/ci-plan.test.ts'],
  })
})

test('unclassified scripts retain full validation', () => {
  expect(planChange({ 'scripts/new-release-step.mjs': 'export {}' })).toMatchObject({
    full: true,
    native: true,
  })
})

test('the real runner selects related tests, isolates its database, and propagates failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-ci-run-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'tests'))
  for (const file of ['ci-plan.mjs', 'run-tests.mjs'])
    copyFileSync(resolve('scripts', file), join(root, 'scripts', file))
  symlinkSync(
    resolve('node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    "export default { test: { include: ['tests/*.test.js'] } }"
  )
  writeFileSync(join(root, 'src/value.js'), 'export const value = 42')
  writeFileSync(
    join(root, 'tests/selected.test.js'),
    `import { test, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { value } from '../src/value.js';
test('selected', () => { expect(value).toBe(42); writeFileSync('selected.json', JSON.stringify(process.env.HIVE_DATA_DIR)); });`
  )
  writeFileSync(
    join(root, 'tests/unrelated.test.js'),
    "import { test, expect } from 'vitest'; test('unrelated failure', () => expect(1).toBe(2));"
  )
  const run = (inputs: string[]) =>
    spawnSync(process.execPath, ['scripts/ci-plan.mjs', '--run'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI_FULL: 'false',
        CI_TEST_INPUTS: JSON.stringify(inputs),
        HIVE_DATA_DIR: join(root, 'user-data'),
      },
    })
  const selected = run(['src/value.js'])
  expect(selected.status, selected.stdout + selected.stderr).toBe(0)
  const dataDir = JSON.parse(readFileSync(join(root, 'selected.json'), 'utf8'))
  expect(dataDir).not.toBe(join(root, 'user-data'))
  expect(existsSync(dataDir)).toBe(false)
  const mixed = run(['src/value.js', 'tests/unrelated.test.js'])
  expect(mixed.status, mixed.stdout + mixed.stderr).toBe(1)
  const failed = run(['tests/unrelated.test.js'])
  expect(failed.status, failed.stdout + failed.stderr).toBe(1)
}, 30000)
