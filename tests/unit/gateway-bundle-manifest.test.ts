import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { buildManifest, sriIntegrity } from '../../scripts/gateway-bundle-manifest.mjs'

// The gateway accepts ONLY this SRI form (gateway/src/bundles.ts SRI_RE). If the manifest the
// release workflow uploads doesn't match it byte-for-byte, the loader won't render the entry and the
// asset route's serve-time re-verify rejects it. So this test is the contract between the CI
// manifest generator and the gateway's verifier.
const GATEWAY_SRI_RE = /^sha384-[A-Za-z0-9+/]{64}={0,2}$/

describe('sriIntegrity', () => {
  test('emits sha384-<base64> matching an independent sha384 of the same bytes', () => {
    const bytes = Buffer.from('export const x = 1\n')
    const expected = `sha384-${createHash('sha384').update(bytes).digest('base64')}`
    expect(sriIntegrity(bytes)).toBe(expected)
    expect(sriIntegrity(bytes)).toMatch(GATEWAY_SRI_RE)
  })

  test('is byte-sensitive — a one-byte flip changes the integrity', () => {
    const a = Buffer.from('console.log(1)')
    const b = Buffer.from('console.log(2)')
    expect(sriIntegrity(a)).not.toBe(sriIntegrity(b))
  })

  test('every emitted integrity is a 64-char base64 sha384 (no truncation/padding drift)', () => {
    // random payloads of varied length: base64 of a 48-byte digest is always 64 chars + '=' pad.
    for (let i = 0; i < 8; i++) {
      const integ = sriIntegrity(randomBytes(1 + i * 37))
      expect(integ).toMatch(GATEWAY_SRI_RE)
    }
  })
})

describe('buildManifest', () => {
  let dist: string

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'hive-bundle-'))
  })
  afterEach(() => {
    rmSync(dist, { recursive: true, force: true })
  })

  test('pins JS as script, CSS as style, under /assets/<version>/, with real sha384', () => {
    const js = Buffer.from('export const app = true\n')
    const css = Buffer.from('body{margin:0}\n')
    mkdirSync(join(dist, 'assets'), { recursive: true })
    writeFileSync(join(dist, 'assets', 'index.js'), js)
    writeFileSync(join(dist, 'assets', 'index.css'), css)

    const m = buildManifest(dist, '2.0.0')
    expect(m.version).toBe('2.0.0')

    const script = m.entries.find((e) => e.kind === 'script')
    const style = m.entries.find((e) => e.kind === 'style')
    expect(script).toBeDefined()
    expect(style).toBeDefined()
    expect(script?.url).toBe('/assets/2.0.0/assets/index.js')
    expect(style?.url).toBe('/assets/2.0.0/assets/index.css')
    // integrity is the real sha384 of the actual bytes, not a placeholder
    expect(script?.integrity).toBe(`sha384-${createHash('sha384').update(js).digest('base64')}`)
    expect(style?.integrity).toBe(`sha384-${createHash('sha384').update(css).digest('base64')}`)
  })

  test('ignores non-JS/CSS assets (source maps, images) — they are not SRI-pinned in the loader', () => {
    writeFileSync(join(dist, 'index.js'), Buffer.from('1'))
    writeFileSync(join(dist, 'index.js.map'), Buffer.from('{}'))
    writeFileSync(join(dist, 'logo.png'), Buffer.from([0x89, 0x50]))

    const m = buildManifest(dist, 'v9')
    const urls = m.entries.map((e) => e.url)
    expect(urls).toEqual(['/assets/v9/index.js'])
    expect(urls.some((u) => u.endsWith('.map') || u.endsWith('.png'))).toBe(false)
  })

  test('is deterministic: entries are url-sorted so two runs produce identical JSON', () => {
    // write in non-sorted order; manifest must still come out sorted + identical across runs.
    writeFileSync(join(dist, 'z.css'), Buffer.from('a'))
    writeFileSync(join(dist, 'a.js'), Buffer.from('b'))
    const first = JSON.stringify(buildManifest(dist, '1.0.0'))
    const second = JSON.stringify(buildManifest(dist, '1.0.0'))
    expect(first).toBe(second)
    expect(buildManifest(dist, '1.0.0').entries.map((e) => e.url)).toEqual([
      '/assets/1.0.0/a.js',
      '/assets/1.0.0/z.css',
    ])
  })
})
