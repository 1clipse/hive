// Versioned mobile-bundle distribution + Subresource Integrity (SRI). GET /assets/<version>/<path>
// serves the immutable, content-versioned web bundle; GET /app serves the bootstrap loader that
// REFERENCES it with a per-asset integrity pin. The phone fetches the bundle by the version its
// daemon reports.
//
// THE THREAT (M6 goal #4, H-SRI-1): the gateway serves the bundle, so a compromised gateway could
// silently swap the JS. SRI narrows that: the loader's <script integrity="sha384-..."> makes the
// browser refuse a script whose bytes don't match the pin, and the asset route recomputes sha384
// over the bytes it is about to serve and refuses to emit anything that doesn't match the manifest.
//
// HONEST LIMITS (documented, NOT marketed away):
//   - The loader page (/app) is itself gateway-served. A gateway compromised BEFORE a device's first
//     load can serve a malicious loader with attacker-chosen integrity values that match attacker JS.
//     This is the classic web-E2E first-contact (TOFU) limit — same as Proton / WhatsApp Web. SRI
//     does NOT make "the gateway is compromised" safe.
//   - The stronger anchor is the version+integrity the DAEMON reports over the E2E (gateway-can't-
//     forge) handshake: the phone pins the expected manifest from the daemon and verifies the gateway-
//     served loader matches before trusting it, and the PWA service worker TOFU-caches the pinned
//     bundle. That anchoring lives on the daemon/phone side; THIS module is the gateway half (emit
//     correct, byte-verified integrity so a *passive* gateway tamper / corrupted asset store is
//     caught).
//   - SRI does nothing against serve-stale / refuse-to-serve DoS — that blast radius is accepted
//     (gateway compromise == denial of service, per the Threat Model).
//
// SECURITY (pre-existing, retained):
//   - Path-traversal: decode the requested path BEFORE checking, then reject anything that isn't a
//     plain relative path strictly under <version>/ (no '..', absolute, backslash, control/space, or
//     encoded traversal like %2e%2e / ..%2f). resolveBundlePath is the single guard, unit-tested.
//   - CORS: same-origin only. We never set Access-Control-Allow-Origin (and never '*').

import { Hono } from 'hono'
import {
  BRAND_ICON_32_B64,
  BRAND_ICON_192_B64,
  BRAND_ICON_512_B64,
  BRAND_ICON_512_MASKABLE_B64,
} from './brand-assets.js'
import { GENERATED_BUNDLE_ASSETS } from './bundle-assets.generated.js'
import { GENERATED_BUNDLE_MANIFEST } from './bundle-manifest.generated.js'
import { HTML_SECURITY_HEADERS } from './daemon.js'
import type { Env } from './env.js'

// Immutable long cache: the version is in the path, so a given URL's bytes never change.
const BUNDLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const ROOT_STATIC_CACHE_CONTROL = 'public, max-age=3600'

// Content-Type for an R2-served file, derived from the VALIDATED path extension only — never from
// R2Object.httpMetadata (the upload side is outside the worker trust root; an attacker who can write
// R2 could mislabel a body). Kept aligned with ship-bundle.mjs's CONTENT_TYPES. Combined with the
// serve-time SRI re-verify + `nosniff`, a wrong-type or wrong-byte body still can't execute.
function contentTypeFor(path: string): string {
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json') || path.endsWith('.map')) return 'application/json; charset=utf-8'
  if (path.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.woff2')) return 'font/woff2'
  if (path.endsWith('.woff')) return 'font/woff'
  if (path.endsWith('.ogg')) return 'audio/ogg'
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  return 'application/octet-stream'
}

// A version segment is a content/release tag: letters, digits, dot, dash, underscore. No slashes, no
// dots-only ('.', '..'), so it can never climb out of /assets/.
const VERSION_RE = /^[A-Za-z0-9._-]+$/

// A resolved path segment must be a plain filename-ish token: letters, digits, dot, dash, underscore.
// Slashes are allowed only BETWEEN segments (handled by splitting), never inside one.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/

// A valid SRI string for us is exactly sha384 + base64 of a 48-byte digest. We deliberately accept
// ONLY sha384 (not sha256/sha512) so the manifest, the served HTML, and the serve-time check all
// speak one algorithm — a downgrade or a bare/blank pin is refused, never trusted.
const SRI_RE = /^sha384-[A-Za-z0-9+/]{64}={0,2}$/

// The security-critical core, pure + directly testable. Decode the requested path, then verify it is
// a clean relative path that stays strictly under `<version>/`. Returns the normalized key
// `<version>/<path>` or null if anything looks like traversal / absolute / malformed.
export function resolveBundlePath(version: string, rawPath: string): string | null {
  if (!VERSION_RE.test(version) || version === '.' || version === '..') return null

  let decoded: string
  try {
    // Decode FIRST so percent-encoded traversal (%2e%2e, ..%2f) is caught by the same checks. A
    // malformed escape sequence throws → reject.
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  if (decoded.length === 0) return null
  // No absolute paths, no backslashes (Windows-style traversal).
  if (decoded.startsWith('/') || decoded.includes('\\')) return null
  // No control bytes, NUL, or spaces — anything at/below 0x20 is rejected before the segment check.
  for (let i = 0; i < decoded.length; i++) {
    if (decoded.charCodeAt(i) <= 0x20) return null
  }

  const segments = decoded.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null // empty / current / parent
    if (!SEGMENT_RE.test(seg)) return null
  }

  return `${version}/${segments.join('/')}`
}

// ── SRI primitive ──────────────────────────────────────────────────────────────
// sha384 of the bytes, base64, prefixed `sha384-` — exactly the form a browser's `integrity=`
// attribute expects. This is the ONE place the algorithm is named; CI emits the manifest with the
// same value, and the serve-time gate recomputes it over the actual bytes.
export async function computeSriIntegrity(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes)
  const view = new Uint8Array(digest)
  let s = ''
  for (const b of view) s += String.fromCharCode(b)
  return `sha384-${btoa(s)}`
}

// Constant-time-ish compare of two equal-length integrity strings. (Both are fixed-form sha384
// base64; a digest match is the real secret, not the comparison timing, but we still avoid an
// early-exit on a partial prefix.)
function integrityEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Serve-time gate: do these bytes match the manifest's pinned integrity? A blank/malformed/non-sha384
// pin is refused outright (we NEVER serve bytes we couldn't pin). This is what stops a tampered or
// corrupted asset store from pushing mismatched JS past the gateway.
export async function verifyAssetIntegrity(bytes: Uint8Array, integrity: string): Promise<boolean> {
  if (!SRI_RE.test(integrity)) return false
  const actual = await computeSriIntegrity(bytes)
  return integrityEqual(actual, integrity)
}

// ── Bundle manifest ──────────────────────────────────────────────────────────────
// CI computes sha384 per emitted JS/CSS asset at release and uploads an immutable manifest with the
// assets. Each entry pins (kind, url, integrity). `kind` decides script vs stylesheet rendering;
// `url` is the absolute /assets/<version>/<file> path the loader references and the bundle route
// serves; `integrity` is the sha384 the browser enforces AND the gateway re-verifies on serve.
export interface BundleManifestEntry {
  readonly kind: 'script' | 'style'
  readonly url: string
  readonly integrity: string
  // True for the chunks the /app loader emits with browser SRI (the entry js + its css). Lazy
  // chunks (isEntry false/undefined) are fetched on demand by the entry and protected ONLY by the
  // serve-time re-verify, so they must NOT appear in the loader. The serve route re-verifies EVERY
  // entry from R2 regardless of this flag. Optional so the in-worker placeholder manifest below
  // (and any hand-written manifest) stays valid; ship-bundle codegen always sets it explicitly.
  readonly isEntry?: boolean
}

export interface BundleManifest {
  readonly version: string
  readonly entries: readonly BundleManifestEntry[]
}

// In-worker default bundle + manifest. In production CI overwrites assets/<version>/ in R2/KV with
// the real Vite output and ships a manifest whose integrity values are the real sha384 of those
// files. Until that pipeline runs, the gateway still serves a *byte-verified* placeholder so the SRI
// contract (loader pins it, route re-verifies it) is real and end-to-end testable now. The integrity
// values below ARE the sha384 of the BUNDLE_ASSETS bytes — change either and the serve-time gate
// rejects the mismatch (which is exactly the property we want).
const PLACEHOLDER_VERSION = 'v0'

const PLACEHOLDER_JS =
  '/* hive mobile bundle loader stub — replaced by CI-uploaded bundle */\nexport const HIVE_BUNDLE_PLACEHOLDER = true;\n'
const PLACEHOLDER_CSS = '/* hive mobile bundle styles stub */\n'

// url -> raw bytes. The route serves from here AFTER re-verifying against the manifest integrity.
const BUNDLE_ASSETS: Readonly<Record<string, { bytes: Uint8Array; contentType: string }>> = {
  [`/assets/${PLACEHOLDER_VERSION}/index.js`]: {
    bytes: new TextEncoder().encode(PLACEHOLDER_JS),
    contentType: 'text/javascript; charset=utf-8',
  },
  [`/assets/${PLACEHOLDER_VERSION}/index.css`]: {
    bytes: new TextEncoder().encode(PLACEHOLDER_CSS),
    contentType: 'text/css; charset=utf-8',
  },
}

// The in-worker fallback manifest, pinning the placeholder BUNDLE_ASSETS above. Used when R2 is
// unbound (local dev / tests) OR the requested version != the anchored current version — so local
// dev and the existing gateway tests keep getting byte-verified bytes without an R2.
const PLACEHOLDER_MANIFEST: BundleManifest = {
  version: PLACEHOLDER_VERSION,
  entries: [
    {
      kind: 'script',
      url: `/assets/${PLACEHOLDER_VERSION}/index.js`,
      // sha384 of PLACEHOLDER_JS — keep in lockstep with the bytes (a test recomputes + asserts).
      integrity: 'sha384-z74g/v1bIx1otKm2QWyBF7rqgsTgdZFjq57TJcxMCf1G1UyVcKpsK26kJGLSL5b5',
      isEntry: true,
    },
    {
      kind: 'style',
      url: `/assets/${PLACEHOLDER_VERSION}/index.css`,
      integrity: 'sha384-woaxIVbXuM8B/gsdX5pLF0+Aqr0FAPiZn2ACIuc8FYDtrWITWJrsTEs3xuZxUPqv',
      isEntry: true,
    },
  ],
}

// THE TRUST ROOT. The worker-anchored manifest for the current release version — baked into the
// worker by `wrangler deploy` (gateway/scripts/ship-bundle.mjs codegen). The serve route reads each
// requested file from R2 and re-verifies its bytes against THESE pins (never against R2, never
// against any request-supplied manifest), and the /app loader emits browser SRI only for the
// isEntry chunks. Committed default is the test-current manifest; CI regenerates it per release.
export const BUNDLE_MANIFEST: BundleManifest = GENERATED_BUNDLE_MANIFEST

// The version the worker is anchored for. A request for /assets/<this>/… is served from R2 + re-
// verified; any OTHER version falls through to the placeholder. Kept in lockstep with the daemon-
// reported version + the R2 keyspace by ship-bundle (the sole writer of the generated manifest).
const CURRENT_VERSION = BUNDLE_MANIFEST.version

// Plan B (no R2): the real CURRENT_VERSION bytes are shipped IN the worker (bundle-assets.generated.ts,
// base64) and decoded once at module load. Empty by default → the route falls through to the v0
// placeholder. Served only after a serve-time re-verify against the worker-anchored BUNDLE_MANIFEST,
// exactly like the R2 path — the bytes' origin (R2 vs in-worker) never relaxes the SRI gate.
const bakedBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
const BAKED_ASSETS: Readonly<Record<string, { bytes: Uint8Array; contentType: string }>> =
  Object.fromEntries(
    Object.entries(GENERATED_BUNDLE_ASSETS).map(([url, v]) => [
      url,
      { bytes: bakedBytes(v.b64), contentType: v.contentType },
    ])
  )

const CLI_ICON_FILES = new Set([
  'claude.png',
  'codex.png',
  'gemini.png',
  'hermes.png',
  'opencode.svg',
])

// ── Bootstrap loader HTML ──────────────────────────────────────────────────────────────
// The page the phone loads. Every asset reference carries integrity + crossorigin="anonymous" (SRI
// requires CORS-mode for cross-checking the response). We REFUSE to render an entry without a valid
// sha384 pin — emitting an unpinned <script> would defeat the whole mechanism, so it's a hard error
// rather than a silently-unprotected tag.
export function renderBootstrapHtml(manifest: BundleManifest): string {
  // Validate EVERY pin BEFORE filtering — a malformed/blank integrity on ANY entry (entry or lazy)
  // is a hard render failure, not a tag we silently skip. (If we filtered first, an entry chunk
  // carrying a garbage pin could slip through as "not isEntry" and weaken the no-unpinned-tag
  // invariant.) Only the isEntry chunks are then emitted; lazy chunks are fetched on demand by the
  // entry and protected by the serve-time re-verify, so they carry NO browser SRI and aren't here.
  for (const e of manifest.entries) {
    if (!SRI_RE.test(e.integrity)) {
      throw new Error(`refusing to render bundle entry without a valid sha384 integrity: ${e.url}`)
    }
  }
  const tags = manifest.entries
    .filter((e) => e.isEntry)
    .map((e) => {
      const url = escapeAttr(e.url)
      const integrity = escapeAttr(e.integrity)
      if (e.kind === 'script') {
        return `<script type="module" src="${url}" integrity="${integrity}" crossorigin="anonymous"></script>`
      }
      return `<link rel="stylesheet" href="${url}" integrity="${integrity}" crossorigin="anonymous">`
    })
  // data: favicon (the bird logo, 32px PNG) — no external fetch, works under img-src 'self' data:
  const faviconDataUri = `data:image/png;base64,${BRAND_ICON_32_B64}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">
<title>Hive</title>
<meta name="theme-color" content="#171717">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" type="image/png" href="${faviconDataUri}">
<link rel="manifest" href="/app.webmanifest">
<style>${LOADER_STYLE_CSS}</style>
${tags.join('\n')}
</head>
<body>
<div id="root">
<div class="hive-loader"><img src="/brand/icon-192.png" width="64" height="64" alt=""><p>Loading Hive…</p></div>
</div>
</body>
</html>`
}

// Attribute-safe escape. The manifest is gateway-controlled, but escaping keeps the page robust if a
// future manifest carries an odd version/file token.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Inline CSS for the loading screen. The content must stay byte-for-byte in sync with
// LOADER_STYLE_HASH below — change the CSS and the hash must be recomputed, otherwise the browser
// will block the style (CSP). Kept minimal: dark bg, centered pulse, no external deps.
export const LOADER_STYLE_CSS = `body{background:#171717;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif}
.hive-loader{display:flex;flex-direction:column;align-items:center;gap:1.5rem}
.hive-loader img{animation:hive-pulse 2s ease-in-out infinite}
.hive-loader p{color:#6b6b6b;font-size:.875rem;letter-spacing:.05em;margin:0}
@keyframes hive-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.95)}}`

// sha384 of LOADER_STYLE_CSS bytes (UTF-8). Keep in lockstep — a test recomputes and asserts.
export const LOADER_STYLE_HASH =
  'sha384-8TNfJal8JsaP+r2+3V5R5WcQ8yDG20E5J/E8kDEX5IrfFKNEAIljcL8cFgIUyevs'

// Brand icons (the bird logo) decoded once at module load — served by /brand/* below. Plan B has
// no R2, so worker-embedded base64 is the only way the gateway origin can serve these bytes.
const decodeB64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
const BRAND_PNGS: Readonly<Record<string, Uint8Array<ArrayBuffer>>> = {
  'icon-192.png': decodeB64(BRAND_ICON_192_B64),
  'icon-512.png': decodeB64(BRAND_ICON_512_B64),
  'icon-512-maskable.png': decodeB64(BRAND_ICON_512_MASKABLE_B64),
}

// CSP for the loader: pin script-src to self and REQUIRE SRI on every script (require-sri-for script).
// A browser that honors it won't run an unpinned/mismatched script even if the HTML were tampered to
// drop an integrity attribute. style-src allows self + the hash-pinned inline loading style (the SPA's
// own stylesheets are covered by 'self'). manifest-src is explicit (fallback to default-src 'self'
// would cover it, but explicit avoids relying on the fallback chain). Retains frame-ancestors 'none'.
const LOADER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  'require-sri-for script',
  `style-src 'self' '${LOADER_STYLE_HASH}'`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
].join('; ')

const LOADER_HEADERS: Readonly<Record<string, string>> = {
  ...HTML_SECURITY_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Security-Policy': LOADER_CSP,
}

export const bundleRoutes = new Hono<{ Bindings: Env }>()

// The loader page. Gateway-served (see HONEST LIMITS above) but every asset it references is SRI-
// pinned and the CSP requires SRI, so a browser refuses any script whose bytes don't match.
bundleRoutes.get('/app', (c) => {
  return c.html(renderBootstrapHtml(BUNDLE_MANIFEST), 200, LOADER_HEADERS)
})

// Web app manifest. Minimal PWA metadata — icons are the bird-logo PNGs served by /brand/* with
// long-lived cache headers (192/512 'any' + a padded 512 maskable for Android adaptive icons).
bundleRoutes.get('/app.webmanifest', (c) => {
  const manifest = {
    name: 'Hive',
    short_name: 'Hive',
    start_url: '/app',
    scope: '/app',
    display: 'standalone',
    theme_color: '#171717',
    background_color: '#171717',
    icons: [
      { src: '/brand/icon-192.png', type: 'image/png', sizes: '192x192', purpose: 'any' },
      { src: '/brand/icon-512.png', type: 'image/png', sizes: '512x512', purpose: 'any' },
      {
        src: '/brand/icon-512-maskable.png',
        type: 'image/png',
        sizes: '512x512',
        purpose: 'maskable',
      },
    ],
  }
  return c.json(manifest, 200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
})

// Brand icon endpoints. Long-lived cache (1 week) — static, version-independent bytes.
// Content-Type is set explicitly; X-Content-Type-Options: nosniff prevents MIME sniffing.
bundleRoutes.get('/brand/:file{icon-(192|512|512-maskable)\\.png}', (c) => {
  const bytes = BRAND_PNGS[c.req.param('file')]
  if (!bytes) return c.notFound()
  return c.body(bytes, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
})

// CLI member avatars are referenced by the SPA as stable root paths (/cli-icons/*), not as
// versioned JS-imported assets. Keep this route intentionally narrow: only the known agent logo
// filenames generated by ship-bundle --bake are served, and no generic dist file browser is exposed.
bundleRoutes.get('/cli-icons/:file{.+}', (c) => {
  let file: string
  try {
    file = decodeURIComponent(c.req.param('file') ?? '')
  } catch {
    return c.text('bad request', 400)
  }
  if (!CLI_ICON_FILES.has(file)) return c.notFound()

  const asset = BAKED_ASSETS[`/cli-icons/${file}`]
  if (asset === undefined) return c.notFound()

  return c.body(asset.bytes.slice().buffer, 200, {
    'Content-Type': asset.contentType,
    'Cache-Control': ROOT_STATIC_CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
  })
})

// `:path{.+}` captures the rest of the path (incl. slashes) after the version. resolveBundlePath
// decodes + guards traversal; the R2 key derives ONLY from its validated output, so encoded
// traversal can never climb out of assets/<version>/. Two serve paths:
//   • R2 PATH (R2 bound AND version == the anchored current version): the manifest-pin lookup gates
//     the R2 read — a file with NO anchored pin 404s BEFORE any ASSETS.get, so a rogue object an
//     attacker wrote to R2 (present but unpinned) is never served. A pinned object is read from R2
//     and re-verified byte→pin (entry AND lazy alike); 502 on mismatch, never serve unverified bytes.
//   • PLACEHOLDER PATH (R2 unbound — local dev / tests — OR a non-current version): the in-worker
//     BUNDLE_ASSETS, byte-verified against PLACEHOLDER_MANIFEST, exactly as before. Keeps local dev
//     and the existing gateway tests green and gives a rolling-deploy daemon a verified fallback.
// Deliberately NO Access-Control-Allow-* beyond what SRI needs (the asset itself is same-origin).
bundleRoutes.get('/assets/:version/:path{.+}', async (c) => {
  const version = c.req.param('version')
  const rest = c.req.param('path') ?? ''

  const resolved = resolveBundlePath(version, rest)
  if (resolved === null) {
    return c.text('bad request', 400)
  }

  const url = `/assets/${resolved}`

  if (c.env.ASSETS !== undefined && version === CURRENT_VERSION) {
    // ── R2 PATH ──
    // 1. Manifest-pin lookup FIRST (worker-anchored, never from R2). No pin → unservable: 404 BEFORE
    //    any R2 read. This ordering is load-bearing — it is what makes an unpinned-but-present rogue
    //    R2 object impossible to serve. NEVER read R2 first and fall through to serving on a pin-miss.
    const entry = BUNDLE_MANIFEST.entries.find((e) => e.url === url)
    if (entry === undefined) {
      return c.text('not found', 404, { 'Cache-Control': BUNDLE_CACHE_CONTROL })
    }
    // 2. R2 key derives only from the validated version+path (resolveBundlePath output) — same
    //    keyspace ship-bundle's upload plan writes (assets/<version>/<dist-relative-path>; a real
    //    Vite build nests its files under assets/, so prod keys read assets/<v>/assets/index-*.js).
    //    A miss → 404 (the worker knows the version but the bytes aren't there yet, e.g. mid-deploy).
    const obj = await c.env.ASSETS.get(`assets/${resolved}`)
    if (obj === null) {
      return c.text('not found', 404, { 'Cache-Control': BUNDLE_CACHE_CONTROL })
    }
    // 3. SERVE-TIME GATE: re-verify the R2 bytes against the worker-anchored pin. A compromised /
    //    corrupted R2 that swaps bytes loses here — we 502 rather than serve unverified bytes the
    //    browser SRI would (for entries) refuse anyway, and which lazy chunks have no other guard for.
    const bytes = new Uint8Array(await obj.arrayBuffer())
    if (!(await verifyAssetIntegrity(bytes, entry.integrity))) {
      return c.text('asset integrity mismatch', 502)
    }
    // Content-Type is worker-derived from the validated path, NEVER R2 metadata (attacker-mislabelable
    // on the upload side). nosniff so a mislabeled body can't be sniffed into script.
    return c.body(bytes.slice().buffer, 200, {
      'Content-Type': contentTypeFor(resolved),
      'Cache-Control': BUNDLE_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
    })
  }

  // ── BAKED IN-WORKER PATH (Plan B: CURRENT_VERSION bytes shipped in the worker, no R2) ──
  // Same trust model as the R2 path: pin lookup in the worker-anchored manifest FIRST, then serve the
  // in-worker bytes ONLY after re-verifying them against that pin (502 on mismatch). Empty BAKED_ASSETS
  // (default) falls straight through to the placeholder, so this is purely additive.
  if (version === CURRENT_VERSION) {
    const bakedEntry = BUNDLE_MANIFEST.entries.find((e) => e.url === url)
    const baked = BAKED_ASSETS[url]
    if (bakedEntry !== undefined && baked !== undefined) {
      if (!(await verifyAssetIntegrity(baked.bytes, bakedEntry.integrity))) {
        return c.text('asset integrity mismatch', 502)
      }
      return c.body(baked.bytes.slice().buffer, 200, {
        'Content-Type': contentTypeFor(resolved),
        'Cache-Control': BUNDLE_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
      })
    }
  }

  // ── PLACEHOLDER PATH (R2 unbound OR non-current version) ──
  const asset = BUNDLE_ASSETS[url]
  const entry = PLACEHOLDER_MANIFEST.entries.find((e) => e.url === url)
  if (asset === undefined || entry === undefined) {
    return c.text('not found', 404, { 'Cache-Control': BUNDLE_CACHE_CONTROL })
  }
  if (!(await verifyAssetIntegrity(asset.bytes, entry.integrity))) {
    return c.text('asset integrity mismatch', 502)
  }
  const buf = asset.bytes.slice().buffer
  return c.body(buf, 200, {
    'Content-Type': asset.contentType,
    'Cache-Control': BUNDLE_CACHE_CONTROL,
  })
})
