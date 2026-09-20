// Realistic mobile-bundle fixture for the R2 serve-path tests (M6.2).
//
// The real Vite output is CODE-SPLIT + HASH-NAMED: an entry index-<hash>.js (+ its index-<hash>.css)
// that the /app loader references, plus many lazy chunks (xterm, MarketplaceDrawer, …) the entry pulls
// on demand. The old placeholder pretended a single index.js; the production R2 path serves many files.
// This fixture mirrors that shape with the SMALLEST realistic set that still exercises every property:
//
//   index-<h>.js   — ENTRY script  (loader-emitted, browser SRI + worker re-verify)
//   index-<h>.css  — ENTRY style   (loader-emitted, browser SRI + worker re-verify)
//   vendor-<h>.js  — LAZY  chunk    (NOT loader-emitted; worker re-verify ONLY)
//
// Each file's `integrity` is the REAL sha384 of its bytes (computed here, not copy-pasted), so the
// serve-time re-verify is exercised against true digests — flip a byte and the gate must 502.
//
// FIXTURE VERSION: the worker anchors ONE current manifest version. We pin the fixture to that version
// so a fetch of /assets/<FIXTURE_VERSION>/<file> hits the R2 path (not the placeholder fallback). The
// version-miss test uses a DIFFERENT version to prove the fallback.

import type { BundleManifestEntry } from '../../src/bundles.js'

// The version the worker-anchored manifest is shipped for. Must match the version the serve route
// treats as "current" (the placeholder fallback kicks in for any OTHER version). Kept here as the one
// fixture knob so the R2-hit vs fallback boundary is explicit in the tests.
export const FIXTURE_VERSION = '1.7.0'

// Hash-named like a real Vite build (index-<8charhash>.js). The hashes are fixed strings — the point
// is realism + stability, not real content hashing; the integrity below is the real sha384 regardless.
export const ENTRY_JS_FILE = 'index-AbCd1234.js'
export const ENTRY_CSS_FILE = 'index-EfGh5678.css'
export const LAZY_JS_FILE = 'vendor-Zz0099Xx.js'

const enc = new TextEncoder()

// Distinct, recognizable bytes per file so a test can assert it got back the RIGHT file's bytes (not
// just "some 200"). The entry imports the lazy chunk by its hashed name — exactly how Vite wires a
// dynamic import — so the fixture reads like a real split bundle.
export const ENTRY_JS_BYTES = enc.encode(
  `import"./${LAZY_JS_FILE}";const HIVE_ENTRY=true;console.log("hive entry boot");\n`
)
export const ENTRY_CSS_BYTES = enc.encode(
  ':root{--hive-bg:#171717}body{margin:0;background:var(--hive-bg)}\n'
)
export const LAZY_JS_BYTES = enc.encode(
  'export const VENDOR_CHUNK=true;export function xtermStub(){return"lazy"}\n'
)

// sha384 base64, `sha384-` prefixed — the exact form SRI_RE accepts and the browser enforces. Computed
// with WebCrypto so it agrees byte-for-byte with the worker's computeSriIntegrity (one algorithm end
// to end); we do NOT hardcode the base64 so a fixture-byte edit can never silently desync the pin.
export async function sri(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes)
  const view = new Uint8Array(digest)
  let s = ''
  for (const b of view) s += String.fromCharCode(b)
  return `sha384-${btoa(s)}`
}

export interface FixtureFile {
  readonly file: string // dist-relative name, e.g. index-AbCd1234.js
  readonly key: string // R2 object key: assets/<version>/<file>
  readonly url: string // serve URL path: /assets/<version>/<file>
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly kind: 'script' | 'style'
  readonly isEntry: boolean
}

// The three fixture files, R2-keyed + URL-keyed off FIXTURE_VERSION. The R2 key is `assets/<v>/<file>`
// (matching ship-bundle's upload plan + the serve route's key derivation); the served URL is
// `/assets/<v>/<file>`.
export const FIXTURE_FILES: readonly Omit<FixtureFile, 'key' | 'url'>[] = [
  {
    file: ENTRY_JS_FILE,
    bytes: ENTRY_JS_BYTES,
    contentType: 'text/javascript; charset=utf-8',
    kind: 'script',
    isEntry: true,
  },
  {
    file: ENTRY_CSS_FILE,
    bytes: ENTRY_CSS_BYTES,
    contentType: 'text/css; charset=utf-8',
    kind: 'style',
    isEntry: true,
  },
  {
    file: LAZY_JS_FILE,
    bytes: LAZY_JS_BYTES,
    contentType: 'text/javascript; charset=utf-8',
    kind: 'script',
    isEntry: false, // lazy: worker re-verify only, NOT in the /app loader
  },
]

export function fixtureKey(file: string): string {
  return `assets/${FIXTURE_VERSION}/${file}`
}

export function fixtureUrl(file: string): string {
  return `/assets/${FIXTURE_VERSION}/${file}`
}

// Build the worker-anchored manifest the way ship-bundle codegen would for this fixture: every JS/CSS
// file pinned with its REAL sha384, `isEntry` marking the two loader-emitted chunks. The test asserts
// the SERVE route re-verifies against pins of this exact shape and the LOADER emits only isEntry ones.
export async function buildFixtureManifest(): Promise<{
  version: string
  entries: (BundleManifestEntry & { isEntry: boolean })[]
}> {
  const entries = await Promise.all(
    FIXTURE_FILES.map(async (f) => ({
      kind: f.kind,
      url: fixtureUrl(f.file),
      integrity: await sri(f.bytes),
      isEntry: f.isEntry,
    }))
  )
  // url-sorted, same determinism ship-bundle guarantees
  entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  return { version: FIXTURE_VERSION, entries }
}
