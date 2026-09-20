import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  BUNDLE_MANIFEST,
  computeSriIntegrity,
  LOADER_STYLE_CSS,
  LOADER_STYLE_HASH,
  renderBootstrapHtml,
  verifyAssetIntegrity,
} from '../src/bundles.js'
import { FIXTURE_FILES, fixtureKey } from './helpers/bundle-fixture.js'

// Bundle SRI / integrity pinning (M6 goal #4, H-SRI-1). The gateway serves the mobile bundle; a
// compromised gateway must not be able to silently swap the JS. Two enforced layers:
//   (1) the bootstrap HTML emits <script ... integrity="sha384-..." crossorigin="anonymous"> for
//       EVERY script/style, read from an immutable manifest, with a CSP that requires SRI on scripts;
//   (2) the asset-serving route recomputes sha384 over the bytes it's about to serve and REFUSES to
//       serve anything whose digest doesn't match the manifest entry (a tampered/corrupted asset
//       store can't push mismatched bytes past the gateway's own check).
// HONEST LIMIT (documented, not tested-away): the loader page itself is gateway-served, so a gateway
// compromised before a device's first load can still serve a malicious loader — classic web-E2E
// first-contact (TOFU/versioning) limit. The daemon-reported-version pin + PWA TOFU cache narrow it
// but do not eliminate it.

const ORIGIN = 'https://app.hivehq.dev'

// The worker-anchored BUNDLE_MANIFEST is now the current (1.7.0) release manifest, so a fetch of one
// of its entries routes to the R2 path. Seed the mock R2 with the same fixture bytes the anchored
// pins cover so the byte-verified serve works regardless of this file's run order vs bundle-r2's own
// beforeAll (singleWorker shares the bucket, but file execution order is not guaranteed — seed here
// so this suite is self-contained and never flakes on a cold R2).
beforeAll(async () => {
  for (const f of FIXTURE_FILES) {
    await env.ASSETS.put(fixtureKey(f.file), f.bytes, {
      httpMetadata: { contentType: f.contentType },
    })
  }
})

describe('computeSriIntegrity — sha384 base64, the integrity primitive', () => {
  test('emits sha384-<base64> and is byte-sensitive (a one-byte flip changes it)', async () => {
    const a = new TextEncoder().encode('console.log(1)')
    const b = new TextEncoder().encode('console.log(2)')
    const ia = await computeSriIntegrity(a)
    const ib = await computeSriIntegrity(b)
    expect(ia.startsWith('sha384-')).toBe(true)
    // base64 of a 48-byte SHA-384 digest is 64 chars (no traversal-y bytes)
    expect(ia.slice('sha384-'.length)).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(ia).not.toBe(ib)
  })

  test('matches the manifest integrity of its own bytes (round-trip)', async () => {
    const bytes = new TextEncoder().encode('export const x = 1')
    const integrity = await computeSriIntegrity(bytes)
    expect(await verifyAssetIntegrity(bytes, integrity)).toBe(true)
  })
})

describe('verifyAssetIntegrity — the serve-time gate', () => {
  test('a one-byte-tampered asset no longer matches the manifest integrity', async () => {
    const original = new TextEncoder().encode('export const safe = true')
    const integrity = await computeSriIntegrity(original)
    const tampered = new TextEncoder().encode('export const safe = fals')
    expect(tampered.byteLength).toBe(original.byteLength) // same length, one byte differs
    expect(await verifyAssetIntegrity(tampered, integrity)).toBe(false)
  })

  test('a missing / malformed integrity string is refused (never trusts unpinned bytes)', async () => {
    const bytes = new TextEncoder().encode('whatever')
    expect(await verifyAssetIntegrity(bytes, '')).toBe(false)
    expect(await verifyAssetIntegrity(bytes, 'sha384-')).toBe(false)
    expect(await verifyAssetIntegrity(bytes, 'md5-deadbeef')).toBe(false)
    expect(await verifyAssetIntegrity(bytes, 'not-an-integrity')).toBe(false)
  })
})

describe('renderBootstrapHtml — every <script>/<link> carries integrity + crossorigin', () => {
  test('emits integrity + crossorigin=anonymous for EVERY asset reference', async () => {
    const html = renderBootstrapHtml(BUNDLE_MANIFEST)
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) {
      expect(tag).toMatch(/\bintegrity="sha384-[^"]+"/)
      expect(tag).toMatch(/\bcrossorigin="anonymous"/)
    }
    // every stylesheet link too
    const styleLinks = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0])
    for (const tag of styleLinks) {
      expect(tag).toMatch(/\bintegrity="sha384-[^"]+"/)
      expect(tag).toMatch(/\bcrossorigin="anonymous"/)
    }
  })

  test('refuses to render a manifest entry that has no/blank integrity (no unpinned script tag)', () => {
    const broken = {
      version: BUNDLE_MANIFEST.version,
      entries: [
        { kind: 'script' as const, url: `/assets/${BUNDLE_MANIFEST.version}/x.js`, integrity: '' },
      ],
    }
    expect(() => renderBootstrapHtml(broken)).toThrow()
  })
})

describe('GET /assets/<version>/<file> — byte-verified serve', () => {
  test('a manifest asset is served, and its bytes verify against the loader integrity', async () => {
    // pull the script entry the loader references, fetch it, and confirm the served bytes hash to the
    // SAME sha384 the loader pins — i.e. the asset route and the loader agree on the exact bytes.
    const entry = BUNDLE_MANIFEST.entries.find((e) => e.kind === 'script')
    expect(entry).toBeDefined()
    if (!entry) return
    const res = await SELF.fetch(`${ORIGIN}${entry.url}`)
    expect(res.status).toBe(200)
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('immutable')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(await computeSriIntegrity(bytes)).toBe(entry.integrity)
    // never cross-origin readable
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('a well-formed but unknown asset still 404s with the immutable cache header', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v9.9.9/missing.js`)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control') ?? '').toContain('immutable')
  })
})

describe('GET /app — gateway-served loader page with SRI + tight CSP', () => {
  test('serves HTML; every script tag has integrity + crossorigin', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html')
    const body = await res.text()
    const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) {
      expect(tag).toMatch(/\bintegrity="sha384-[^"]+"/)
      expect(tag).toMatch(/\bcrossorigin="anonymous"/)
    }
  })

  test('CSP requires SRI on scripts and pins script-src to self', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain('require-sri-for script')
    expect(csp).toContain("script-src 'self'")
    // still frame-busted like every other HTML surface
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('the loader leaks no gateway secret (sentinel-leak guard extends here)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const body = await res.text()
    // the gateway test secrets are distinctive sentinels; none may appear in the loader page
    expect(body).not.toContain('DO-NOT-LEAK')
  })

  test('the integrity values in the served HTML are real sha384 of the manifest ENTRY chunks', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const body = await res.text()
    // entry-only emission (new contract): only isEntry chunks are referenced by the loader with
    // browser SRI; lazy chunks carry no browser SRI (worker re-verify is their only guard) so their
    // integrity is deliberately NOT in the loader. Iterating all entries here would (rightly) miss
    // the lazy pin — so we assert over the entry chunks the loader is contractually responsible for.
    const entryChunks = BUNDLE_MANIFEST.entries.filter((e) => e.isEntry)
    expect(entryChunks.length).toBeGreaterThan(0)
    for (const entry of entryChunks) {
      // each entry chunk's integrity must appear verbatim in the served loader
      expect(body).toContain(entry.integrity)
      expect(entry.integrity.startsWith('sha384-')).toBe(true)
    }
  })
})

describe('LOADER_STYLE_HASH — inline style CSP pin lockstep', () => {
  test('LOADER_STYLE_HASH is the real sha384 of LOADER_STYLE_CSS (any drift breaks the CSP)', async () => {
    // If this fails, re-run: node -e "require('crypto').createHash('sha384').update(css,'utf8').digest('base64')"
    // over the LOADER_STYLE_CSS string and update LOADER_STYLE_HASH in bundles.ts.
    const bytes = new TextEncoder().encode(LOADER_STYLE_CSS)
    const computed = await computeSriIntegrity(bytes)
    expect(computed).toBe(LOADER_STYLE_HASH)
  })

  test('loader CSP style-src contains the pinned hash', async () => {
    const res = await SELF.fetch('https://app.hivehq.dev/app')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain(LOADER_STYLE_HASH)
    expect(csp).toContain('style-src')
  })
})
