import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const readRequiredFile = (path) => {
  expect(existsSync(path)).toBe(true)
  return readFileSync(path, 'utf8')
}

test('root project config exists', () => {
  expect(existsSync('package.json')).toBe(true)
  expect(existsSync('tsconfig.json')).toBe(true)
  expect(existsSync('vitest.config.ts')).toBe(true)
})

test('public package metadata is ready for external users', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(packageJson.license).toBe('BUSL-1.1')
  expect(packageJson.description).toContain('Run Claude Code, Codex, Gemini, OpenCode, Qwen')
  for (const agent of ['Claude Code', 'Codex', 'OpenCode', 'Gemini', 'Qwen']) {
    expect(packageJson.description).toContain(agent)
  }
  expect(packageJson.description).toContain('visible local team')
  expect(packageJson.keywords).toEqual(
    expect.arrayContaining(['ai-agents', 'cli', 'collaboration', 'multi-agent', 'workspace'])
  )
  expect(packageJson.files).toEqual(
    expect.arrayContaining(['CHANGELOG.md', 'LICENSE', 'LICENSE.BSL', 'README.md', 'SECURITY.md'])
  )
})

test('public support documents describe license, safety, and release scope', () => {
  const changelog = readRequiredFile('CHANGELOG.md')
  const englishReadme = readRequiredFile('README.en.md')
  const license = readRequiredFile('LICENSE')
  const licenseBsl = readRequiredFile('LICENSE.BSL')
  const readme = readRequiredFile('README.md')
  const chineseReadme = readRequiredFile('README.zh.md')
  const releaseDocs = readRequiredFile('docs/release.md')
  const security = readRequiredFile('SECURITY.md')
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

  expect(changelog).toContain(`## ${packageJson.version}`)
  expect(license).toContain('Apache License')
  expect(license).toContain('Version 2.0')
  expect(licenseBsl).toContain('Business Source License 1.1')
  expect(licenseBsl).toContain('2030-05-16')
  expect(readme).toContain('Quick Start')
  expect(readme).toContain('Platform Support')
  expect(readme).toContain('Safety Model')
  expect(chineseReadme).toContain('快速开始')
  expect(chineseReadme).toContain('平台支持')
  expect(chineseReadme).toContain('安全模型')
  expect(englishReadme).toContain('[README.md](./README.md)')
  expect(englishReadme).toContain('[README.zh.md](./README.zh.md)')
  expect(releaseDocs).toContain('NPM_TOKEN')
  expect(security).toContain('Reporting a Vulnerability')
  expect(security).toContain('127.0.0.1')
  expect(security).toContain('arbitrary shell commands')
})
