import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import {
  CHANGELOG,
  type ChangelogEntry,
  compareVersions,
  selectWhatsNew,
} from '../../web/src/whats-new/changelog.js'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const entry = (version: string): ChangelogEntry => ({
  version,
  date: '2026-01-01',
  en: [`en ${version}`],
  zh: [`zh ${version}`],
})

const LOG = [entry('1.4.6'), entry('1.4.5'), entry('1.4.4')]

describe('compareVersions', () => {
  test('orders by major/minor/patch', () => {
    expect(compareVersions('1.4.5', '1.4.4')).toBeGreaterThan(0)
    expect(compareVersions('1.4.4', '1.4.5')).toBeLessThan(0)
    expect(compareVersions('1.4.4', '1.4.4')).toBe(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  test('a prerelease sorts before its release', () => {
    expect(compareVersions('1.4.5-beta.1', '1.4.5')).toBeLessThan(0)
  })
})

describe('selectWhatsNew', () => {
  test('fresh install (no last-seen) seeds silently and does not show', () => {
    const result = selectWhatsNew('1.4.6', null, LOG)
    expect(result.show).toBe(false)
    expect(result.seedOnly).toBe(true)
    expect(result.entries).toEqual([])
  })

  test('same version does not show and does not seed', () => {
    const result = selectWhatsNew('1.4.6', '1.4.6', LOG)
    expect(result).toEqual({ show: false, entries: [], seedOnly: false })
  })

  test('downgrade does not show and leaves last-seen untouched', () => {
    const result = selectWhatsNew('1.4.4', '1.4.6', LOG)
    expect(result).toEqual({ show: false, entries: [], seedOnly: false })
  })

  test('upgrade shows exactly the entries in (lastSeen, current]', () => {
    const result = selectWhatsNew('1.4.6', '1.4.4', LOG)
    expect(result.show).toBe(true)
    expect(result.seedOnly).toBe(false)
    expect(result.entries.map((item) => item.version)).toEqual(['1.4.6', '1.4.5'])
  })

  test('a multi-version skip collects every in-range entry', () => {
    const result = selectWhatsNew('1.4.6', '1.4.3', LOG)
    expect(result.entries.map((item) => item.version)).toEqual(['1.4.6', '1.4.5', '1.4.4'])
  })

  test('upgrade with no curated notes in range seeds silently, no empty dialog', () => {
    const result = selectWhatsNew('1.5.0', '1.4.9', LOG)
    expect(result.show).toBe(false)
    expect(result.seedOnly).toBe(true)
    expect(result.entries).toEqual([])
  })
})

describe('CHANGELOG data integrity (release gate)', () => {
  test('the top entry matches package.json version — bumping without a note fails here', () => {
    expect(CHANGELOG[0]?.version).toBe(pkg.version)
  })

  test('versions are unique and sorted newest-first', () => {
    const versions = CHANGELOG.map((item) => item.version)
    expect(new Set(versions).size).toBe(versions.length)
    const sorted = [...versions].sort((a, b) => compareVersions(b, a))
    expect(versions).toEqual(sorted)
  })

  test('every entry carries non-empty bilingual highlights and an ISO date', () => {
    for (const item of CHANGELOG) {
      expect(item.en.length, `${item.version} en`).toBeGreaterThan(0)
      expect(item.zh.length, `${item.version} zh`).toBeGreaterThan(0)
      expect(item.en.every((line) => line.trim().length > 0)).toBe(true)
      expect(item.zh.every((line) => line.trim().length > 0)).toBe(true)
      expect(item.date, `${item.version} date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
