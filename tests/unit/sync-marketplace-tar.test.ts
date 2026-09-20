import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, test } from 'vitest'

type ExtractTarball = (tarballPath: string, destDir: string) => string

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const loadExtractor = async () => {
  // @ts-expect-error scripts are plain ESM and intentionally not part of the TS build.
  const mod = (await import('../../scripts/sync-marketplace.mjs')) as {
    extractTarball: ExtractTarball
  }
  return mod.extractTarball
}

const writeOctal = (header: Buffer, value: number, offset: number, length: number) => {
  header.write(
    value
      .toString(8)
      .padStart(length - 1, '0')
      .slice(-(length - 1)),
    offset,
    'ascii'
  )
  header[offset + length - 1] = 0
}

type TarEntryType = '0' | '5' | 'x'

const createTarEntry = (name: string, content: Buffer, type: TarEntryType = '0') => {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8')
  writeOctal(header, type === '5' ? 0o755 : 0o644, 100, 8)
  writeOctal(header, 0, 108, 8)
  writeOctal(header, 0, 116, 8)
  writeOctal(header, type === '5' ? 0 : content.length, 124, 12)
  writeOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header.write(type, 156, 'ascii')
  header.write('ustar', 257, 'ascii')
  header.write('00', 263, 'ascii')

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii')
  header[154] = 0
  header[155] = 0x20

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0)
  return Buffer.concat([header, type === '5' ? Buffer.alloc(0) : content, padding])
}

const createPaxRecord = (key: string, value: string) => {
  const payload = `${key}=${value}\n`
  let length = Buffer.byteLength(payload) + 2
  while (true) {
    const nextLength = Buffer.byteLength(payload) + String(length).length + 1
    if (nextLength === length) break
    length = nextLength
  }
  return Buffer.from(`${length} ${payload}`, 'utf8')
}

const writeTarball = (entries: Array<{ name: string; content?: string; type?: TarEntryType }>) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-marketplace-tar-'))
  tempDirs.push(dir)
  const tarball = join(dir, 'fixture.tgz')
  const tar = Buffer.concat([
    ...entries.map((entry) =>
      createTarEntry(entry.name, Buffer.from(entry.content ?? '', 'utf8'), entry.type ?? '0')
    ),
    Buffer.alloc(1024, 0),
  ])
  writeFileSync(tarball, gzipSync(tar))
  return { dir, tarball }
}

describe('sync-marketplace tar extraction', () => {
  test('extracts a gzip tarball without the external tar command', async () => {
    const extractTarball = await loadExtractor()
    const { dir, tarball } = writeTarball([
      { name: 'repo-root/', type: '5' },
      { name: 'repo-root/agents/backend.md', content: '# Backend\n' },
    ])
    const dest = join(dir, 'extract')

    const root = extractTarball(tarball, dest)

    expect(basename(root)).toBe('repo-root')
    expect(readFileSync(join(root, 'agents', 'backend.md'), 'utf8')).toBe('# Backend\n')
  })

  test('uses pax path record byte lengths for non-ASCII entry paths', async () => {
    const extractTarball = await loadExtractor()
    const { dir, tarball } = writeTarball([
      { name: 'repo-root/', type: '5' },
      {
        name: 'pax-header',
        content: createPaxRecord('path', 'repo-root/国际/agent.md').toString('utf8'),
        type: 'x',
      },
      { name: 'placeholder.md', content: '# Localized\n' },
    ])
    const dest = join(dir, 'extract')

    const root = extractTarball(tarball, dest)

    expect(readFileSync(join(root, '国际', 'agent.md'), 'utf8')).toBe('# Localized\n')
  })

  test('rejects path traversal entries before writing outside the destination', async () => {
    const extractTarball = await loadExtractor()
    const { dir, tarball } = writeTarball([{ name: '../escape.md', content: 'bad' }])
    const dest = join(dir, 'extract')

    expect(() => extractTarball(tarball, dest)).toThrow(/Unsafe tar entry path/)
    expect(existsSync(join(dir, 'escape.md'))).toBe(false)
  })
})
