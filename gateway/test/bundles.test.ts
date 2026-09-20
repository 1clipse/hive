import { SELF } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import { resolveBundlePath } from '../src/bundles.js'

// Versioned mobile-bundle distribution. M2 scope = route shape + the immutable long-cache header
// contract + a STRICT path-traversal guard (decode-then-check, not just literal '..') + same-origin
// CORS posture (NEVER ACAO:* — HARDEN §7.3). No asset store yet, so a valid path 404s, but with the
// correct headers so index wiring is complete. Each assert fails on the obvious broken impl.

const ORIGIN = 'https://app.hivehq.dev'

describe('GET /assets/:version/* — header + CORS contract', () => {
  test('unknown asset → 404 BUT carries the immutable long-cache header', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v1.2.3/app.js`)
    expect(res.status).toBe(404)
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('max-age=31536000')
  })

  test('NO Access-Control-Allow-Origin (same-origin only, never *)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v1.2.3/app.js`, {
      headers: { Origin: 'https://evil.example' },
    })
    // a wildcard / reflected ACAO would expose the bundle (and by-pattern other endpoints) cross-origin
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})

describe('path-traversal guard (HARDEN §7.3 — decode then check)', () => {
  // NOTE: a LITERAL `..` in the URL is collapsed by the HTTP/URL layer before routing (so it can
  // never reach the handler as traversal — it 404s as a non-matching path). The attack that actually
  // reaches the worker is percent-ENCODED traversal, which the router decodes only after matching the
  // route — that's what the guard must catch. The pure resolveBundlePath suite below covers the
  // literal-`..` segment directly (the layer where it's reachable).
  test('percent-encoded traversal (%2e%2e%2f) reaches the route and is rejected → 400', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v1/%2e%2e%2f%2e%2e%2fsecret`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(400)
  })

  test('encoded ..%2f traversal → 400', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v1/..%2fsecret`, { redirect: 'manual' })
    expect(res.status).toBe(400)
  })
})

describe('resolveBundlePath — pure guard (the security-critical core, unit-tested directly)', () => {
  test('a clean path resolves under /assets/<version>/', () => {
    expect(resolveBundlePath('v1.2.3', 'app.js')).toBe('v1.2.3/app.js')
    expect(resolveBundlePath('v1.2.3', 'static/main.css')).toBe('v1.2.3/static/main.css')
  })

  test('literal traversal → null', () => {
    expect(resolveBundlePath('v1', '../secret')).toBeNull()
    expect(resolveBundlePath('v1', 'a/../../secret')).toBeNull()
  })

  test('percent-encoded traversal → null (decoded BEFORE the check, so %2e%2e is caught)', () => {
    expect(resolveBundlePath('v1', '%2e%2e/secret')).toBeNull()
    expect(resolveBundlePath('v1', '..%2fsecret')).toBeNull()
  })

  test('absolute / backslash / null-byte segments → null', () => {
    expect(resolveBundlePath('v1', '/etc/passwd')).toBeNull()
    expect(resolveBundlePath('v1', 'a\\..\\b')).toBeNull()
    expect(resolveBundlePath('v1', 'a\x00b')).toBeNull()
  })

  test('an empty or malformed version → null (no bare /assets// root access)', () => {
    expect(resolveBundlePath('', 'app.js')).toBeNull()
    expect(resolveBundlePath('..', 'app.js')).toBeNull()
  })
})

describe('GET /app.webmanifest — PWA manifest', () => {
  test('200 with application/manifest+json content-type', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('application/manifest+json')
  })

  test('manifest JSON has expected PWA fields', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app.webmanifest`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('Hive')
    expect(body.short_name).toBe('Hive')
    expect(body.display).toBe('standalone')
    expect(body.start_url).toBe('/app')
    expect(body.theme_color).toBe('#171717')
    // Icons are the bird-logo PNGs served by /brand/* (192 + 512 any, 512 maskable).
    const icons = body.icons as Array<{ src: string; purpose?: string }>
    expect(icons.map((i) => i.src)).toEqual([
      '/brand/icon-192.png',
      '/brand/icon-512.png',
      '/brand/icon-512-maskable.png',
    ])
    expect(icons[2]?.purpose).toBe('maskable')
  })
})

describe('GET /brand/icon-*.png — brand icons', () => {
  test('192/512/maskable all serve 200 with image/png content-type', async () => {
    for (const f of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png']) {
      const res = await SELF.fetch(`${ORIGIN}/brand/${f}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type') ?? '').toContain('image/png')
    }
  })

  test('response bytes are a real PNG (magic header), not a placeholder', async () => {
    const res = await SELF.fetch(`${ORIGIN}/brand/icon-192.png`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    // PNG signature: 89 50 4E 47
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(bytes.length).toBeGreaterThan(1000)
  })

  test('an unknown brand path 404s', async () => {
    const res = await SELF.fetch(`${ORIGIN}/brand/evil.png`)
    expect(res.status).toBe(404)
  })
})

describe('GET /app loader HTML — PWA meta and manifest link', () => {
  test('loader HTML links the web manifest', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const body = await res.text()
    expect(body).toContain('rel="manifest"')
    expect(body).toContain('/app.webmanifest')
  })

  test('loader HTML has theme-color and apple PWA meta tags', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const body = await res.text()
    expect(body).toContain('name="theme-color"')
    expect(body).toContain('#171717')
    expect(body).toContain('apple-mobile-web-app-capable')
  })
})
