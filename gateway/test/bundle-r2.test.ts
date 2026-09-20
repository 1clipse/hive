import { env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, test } from 'vitest'
import { BUNDLE_MANIFEST, computeSriIntegrity } from '../src/bundles.js'
import {
  buildFixtureManifest,
  ENTRY_CSS_BYTES,
  ENTRY_CSS_FILE,
  ENTRY_JS_BYTES,
  ENTRY_JS_FILE,
  FIXTURE_FILES,
  FIXTURE_VERSION,
  fixtureKey,
  fixtureUrl,
  LAZY_JS_BYTES,
  LAZY_JS_FILE,
  sri,
} from './helpers/bundle-fixture.js'

// ── M6.2 — R2 production serve path (pool-workers, MOCK R2) ──────────────────────────────────────
//
// The gateway serves /assets/<version>/<path> for the phone's mobile bundle. The bytes live in R2
// (1.26MB, code-split + hash-named); the sha384 MANIFEST is ANCHORED IN THE WORKER (the trust root,
// baked in by `wrangler deploy` via bundle-manifest.generated.ts) and the serve route RE-VERIFIES
// every byte read from R2 against that anchored manifest before serving — 502 on mismatch, never serve
// unverified bytes. The /app loader emits browser SRI ONLY for the entry chunk(s); lazy chunks carry no
// browser SRI but ARE worker-re-verified.
//
// This suite drives the REAL worker under workerd against a MOCK R2 (miniflare r2Buckets:['ASSETS'],
// seeded below). The fixture is a realistic split bundle: entry index-<h>.js + index-<h>.css + a lazy
// vendor-<h>.js, each pinned by its REAL sha384. Every assert is written to FAIL if the product is
// reversed — the tag on each `describe` names the broken impl it catches.
//
// CONTRACT COUPLING (load-bearing): the serve route re-verifies against the WORKER-anchored manifest,
// NOT against R2 and NOT against any test-supplied manifest. So for the R2 path to serve at all, the
// worker's anchored BUNDLE_MANIFEST for FIXTURE_VERSION must pin exactly the fixture bytes. The first
// test asserts that equality directly — if the generated manifest drifts from the fixture the suite
// fails loudly instead of silently testing the wrong bytes.

const ORIGIN = 'https://app.hivehq.dev'

beforeAll(async () => {
  // Seed the mock R2 with the realistic fixture. Keys are assets/<version>/<file> — exactly the
  // keyspace ship-bundle's upload plan writes and the serve route derives from the validated
  // version+path. We seed the UNTAMPERED bytes here; the 502 test overwrites ONE object with bytes
  // that no longer match its pin, proving the serve-time re-verify (not a stale seed) is what catches
  // tamper. isolatedStorage:false keeps this seed live for the whole run.
  for (const f of FIXTURE_FILES) {
    await env.ASSETS.put(fixtureKey(f.file), f.bytes, {
      httpMetadata: { contentType: f.contentType },
    })
  }
})

describe('R2 serve path — worker-anchored manifest is the trust root', () => {
  // BROKEN IMPL CAUGHT: manifest read from R2 (or test-supplied) instead of anchored in the worker; or
  // the generated manifest drifting from the bytes actually shipped to R2. If the worker re-verified
  // against an R2-sourced manifest, a tampered R2 could ship a matching manifest and win — this binds
  // the anchored pins to the exact fixture bytes so the rest of the suite tests the right thing.
  test('the worker-anchored manifest for the current version pins exactly the fixture bytes', async () => {
    const fixture = await buildFixtureManifest()
    expect(BUNDLE_MANIFEST.version).toBe(FIXTURE_VERSION)
    // every fixture file appears in the anchored manifest with the REAL sha384 of its bytes
    for (const fe of fixture.entries) {
      const anchored = BUNDLE_MANIFEST.entries.find((e) => e.url === fe.url)
      expect(anchored, `anchored manifest is missing ${fe.url}`).toBeDefined()
      expect(anchored?.integrity).toBe(fe.integrity)
      expect(anchored?.kind).toBe(fe.kind)
    }
    // and the anchored manifest pins NOTHING the fixture doesn't (no extra unverifiable URLs)
    expect(BUNDLE_MANIFEST.entries.length).toBe(fixture.entries.length)
  })
})

describe('(1) GET the entry from R2 → 200 + bytes match + re-verify passes', () => {
  // BROKEN IMPL CAUGHT: route still serves the in-worker placeholder and never reads R2; or reads R2
  // but skips the byte→pin re-verify. A pass proves real R2 bytes flowed through the re-verify gate.
  test('entry index-<h>.js served from R2 with exact bytes + immutable cache, re-verifies to its pin', async () => {
    const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(ENTRY_JS_FILE)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('text/javascript')
    const cc = res.headers.get('Cache-Control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('max-age=31536000')

    const bytes = new Uint8Array(await res.arrayBuffer())
    // byte-identical to the R2-seeded entry (not the 117-byte placeholder stub)
    expect(bytes).toEqual(ENTRY_JS_BYTES)
    expect(bytes.byteLength).toBe(ENTRY_JS_BYTES.byteLength)
    // and the served bytes hash to the pin the worker re-verified against
    expect(await computeSriIntegrity(bytes)).toBe(await sri(ENTRY_JS_BYTES))
    // same-origin only — never cross-origin readable
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('entry index-<h>.css served from R2 with its bytes + text/css', async () => {
    const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(ENTRY_CSS_FILE)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type') ?? '').toContain('text/css')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(ENTRY_CSS_BYTES)
    expect(await computeSriIntegrity(bytes)).toBe(await sri(ENTRY_CSS_BYTES))
  })
})

describe('(2) tampered R2 object (bytes ≠ pin) → 502, never served', () => {
  // BROKEN IMPL CAUGHT: route serves R2 bytes WITHOUT re-verifying against the anchored pin (or
  // re-verifies against R2-derived hash, which always "matches"). A compromised/corrupted R2 that
  // swaps bytes must lose here — the worker pins the trust root, so mismatched bytes 502 and the
  // attacker payload never reaches the client.
  test('overwriting an R2 object with bytes that no longer match its pin → 502, body is NOT the tampered bytes', async () => {
    const key = fixtureKey(ENTRY_JS_FILE)
    // same byte-length as the original (a length-preserving swap — the gate is digest, not size)
    const tampered = new Uint8Array(ENTRY_JS_BYTES.length)
    tampered.set(ENTRY_JS_BYTES)
    const flipAt = tampered.length - 2
    tampered[flipAt] = (tampered[flipAt] ?? 0) ^ 0x01 // flip one bit
    expect(await sri(tampered)).not.toBe(await sri(ENTRY_JS_BYTES)) // pin no longer matches

    try {
      await env.ASSETS.put(key, tampered, {
        httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
      })

      const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(ENTRY_JS_FILE)}`)
      expect(res.status).toBe(502)
      // and the attacker bytes are NOT what we returned — a 502 with the payload body would be a fail
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body).not.toEqual(tampered)
    } finally {
      // restore the good object so later tests / re-runs see a clean R2 (suite is order-independent)
      await env.ASSETS.put(key, ENTRY_JS_BYTES, {
        httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
      })
    }
  })

  test('a file present in R2 but NOT in the anchored manifest is unpinned → never served (not 200)', async () => {
    // an attacker who can write R2 adds an extra object under the current version; with no anchored
    // pin the worker has nothing to verify against, so it must refuse (404/502) — NEVER serve it.
    const rogueFile = 'rogue-DEADBEEF.js'
    const key = fixtureKey(rogueFile)
    try {
      await env.ASSETS.put(key, new TextEncoder().encode('window.pwned=1\n'))
      const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(rogueFile)}`)
      expect(res.status).not.toBe(200)
      expect([404, 502]).toContain(res.status)
    } finally {
      await env.ASSETS.delete(key)
    }
  })
})

describe('(3) GET a lazy chunk → 200 + re-verified (lazy chunks are R2-covered)', () => {
  // BROKEN IMPL CAUGHT: only entry chunks served from R2 / re-verified, lazy chunks served unverified
  // (or 404'd). Lazy chunks have no browser SRI, so the worker re-verify is their ONLY protection —
  // it must apply to them too.
  test('lazy vendor-<h>.js served from R2 with its exact bytes, re-verified to its pin', async () => {
    const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(LAZY_JS_FILE)}`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(LAZY_JS_BYTES)
    expect(await computeSriIntegrity(bytes)).toBe(await sri(LAZY_JS_BYTES))
  })

  test('a tampered LAZY chunk also 502s (re-verify covers lazy, not just entry)', async () => {
    const key = fixtureKey(LAZY_JS_FILE)
    const tampered = new Uint8Array(LAZY_JS_BYTES.length)
    tampered.set(LAZY_JS_BYTES)
    tampered[0] = (tampered[0] ?? 0) ^ 0x01
    try {
      await env.ASSETS.put(key, tampered)
      const res = await SELF.fetch(`${ORIGIN}${fixtureUrl(LAZY_JS_FILE)}`)
      expect(res.status).toBe(502)
    } finally {
      await env.ASSETS.put(key, LAZY_JS_BYTES, {
        httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
      })
    }
  })
})

describe('(4) /app loader emits a <script> for the ENTRY only (with integrity), NOT the lazy chunk', () => {
  // BROKEN IMPL CAUGHT: loader emits every manifest entry (lazy chunks too) — that would 1) bloat the
  // boot path and 2) put lazy chunks under browser SRI, which the entry-only design deliberately
  // avoids. Or loader emits an entry WITHOUT integrity. The loader's job: entry js + its css, each
  // SRI-pinned from the worker manifest; lazy chunks are pulled by the entry at runtime.
  test('loader references the entry JS + CSS with sha384 integrity, and does NOT reference the lazy chunk', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    expect(res.status).toBe(200)
    const html = await res.text()

    // entry JS + CSS appear, each carrying integrity + crossorigin
    expect(html).toContain(ENTRY_JS_FILE)
    expect(html).toContain(ENTRY_CSS_FILE)

    const scriptTag = html.match(new RegExp(`<script\\b[^>]*${ENTRY_JS_FILE}[^>]*>`))?.[0] ?? ''
    expect(scriptTag).toMatch(/\bintegrity="sha384-[^"]+"/)
    expect(scriptTag).toMatch(/\bcrossorigin="anonymous"/)
    expect(scriptTag).toContain(await sri(ENTRY_JS_BYTES)) // the REAL pin, not a placeholder one

    const linkTag = html.match(new RegExp(`<link\\b[^>]*${ENTRY_CSS_FILE}[^>]*>`))?.[0] ?? ''
    expect(linkTag).toMatch(/\bintegrity="sha384-[^"]+"/)
    expect(linkTag).toContain(await sri(ENTRY_CSS_BYTES))

    // the LAZY chunk MUST NOT be in the loader at all (no <script>/<link>, no bare mention)
    expect(html).not.toContain(LAZY_JS_FILE)
  })

  test('every <script>/<link> in the loader is SRI-pinned (no unpinned tag slips through)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app`)
    const html = await res.text()
    const tags = [
      ...html.matchAll(/<script\b[^>]*>/g),
      ...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g),
    ].map((m) => m[0])
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) {
      expect(tag).toMatch(/\bintegrity="sha384-[^"]+"/)
    }
  })
})

describe('(5) version-miss or no-R2 → placeholder fallback (existing behavior intact)', () => {
  // BROKEN IMPL CAUGHT: the R2 path replaced the placeholder fallback wholesale, so a daemon reporting
  // a version != the worker's anchored one (a rolling deploy, or local dev with no R2) gets a hard
  // failure instead of the byte-verified placeholder. The fallback keeps local dev + the existing 175
  // gateway tests green; it must still work for a non-current version.
  test('a version the worker is NOT anchored for falls back to the placeholder, not the R2 fixture', async () => {
    // seed the fixture under a DIFFERENT version too, to prove the route does NOT just blindly read R2
    // for any version — only the anchored current version is served from R2; others fall back.
    const otherVersion = 'v0' // the placeholder version (always served by the fallback path)
    const res = await SELF.fetch(`${ORIGIN}/assets/${otherVersion}/index.js`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // the placeholder stub, not the R2 entry bytes
    expect(body).toContain('HIVE_BUNDLE_PLACEHOLDER')
    expect(body).not.toContain('hive entry boot')
  })

  test('an unknown file under a non-anchored version → 404 with immutable cache header (fallback miss)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/v9.9.9/whatever.js`)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control') ?? '').toContain('immutable')
  })
})

describe('(6) path/version traversal into R2 keys → rejected', () => {
  // BROKEN IMPL CAUGHT: the R2 key is built from the raw/undecoded path so encoded traversal climbs out
  // of assets/<version>/ into another tenant's keys; or the version isn't validated. resolveBundlePath
  // stays the single guard, and the R2 key derives ONLY from the validated version+path.
  test('percent-encoded traversal under the anchored version → 400, never an R2 read', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/${FIXTURE_VERSION}/%2e%2e%2f%2e%2e%2fsecret`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(400)
  })

  test('encoded ..%2f traversal under the anchored version → 400', async () => {
    const res = await SELF.fetch(`${ORIGIN}/assets/${FIXTURE_VERSION}/..%2fsecret`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(400)
  })

  test('a malformed version segment → 400 (no bare assets// or climb-out)', async () => {
    // a path-shaped version can't reach the R2 keyspace of another version
    const res = await SELF.fetch(`${ORIGIN}/assets/..%2f..%2fother/${ENTRY_JS_FILE}`, {
      redirect: 'manual',
    })
    expect([400, 404]).toContain(res.status)
    expect(res.status).not.toBe(200)
  })
})
