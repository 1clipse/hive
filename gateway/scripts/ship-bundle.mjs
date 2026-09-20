// Repeatable ship script for the gateway's versioned mobile bundle (M6.2).
//
// THE PROBLEM IT SOLVES: the gateway serves /assets/<version>/<path> from R2, but the sha384
// MANIFEST that gates those bytes must be ANCHORED IN THE DEPLOYED WORKER (the trust root). The
// manifest can NEVER come from R2 — a compromised R2 that serves different bytes than the worker
// manifest pins must lose at the serve-time re-verify. So shipping a bundle is three coupled steps:
//
//   1. compute the sha384 manifest from the built web/dist (entry detection from index.html)
//   2. codegen gateway/src/bundle-manifest.generated.ts so `wrangler deploy` ships THAT manifest
//      baked into the worker
//   3. upload the bytes to R2 under assets/<version>/<path>
//
// This script does (1) + (2) deterministically + idempotently, and emits the R2 upload PLAN for (3)
// (files + keys + content-types). The live `wrangler deploy` and `wrangler r2 object put` are run by
// the owner/CI AFTER this script — never here (no network, no prod side effects).
//
// ORDER MATTERS (and CI enforces it): deploy the worker (with the new anchored manifest) FIRST, then
// upload bytes. The serve route 404s a version it doesn't know and 502s bytes that don't match, so
// uploading bytes before the worker knows the version is harmless; deploying the manifest before the
// bytes exist just means a brief window of 404 until the upload completes. Either order is safe;
// CI does deploy→upload so the manifest is always live before the bytes it pins.
//
// Usage:
//   node gateway/scripts/ship-bundle.mjs --dist <distDir> --version <v> [--out <file>] [--plan <file>]
//
// Defaults: --dist web/dist, --out gateway/src/bundle-manifest.generated.ts, --plan stdout(JSON).
//
// The manifest computation (sha384 + entry detection) is the SAME helper the gateway's serve-time
// re-verify agrees with byte-for-byte (scripts/gateway-bundle-manifest.mjs). We reuse it so there is
// ONE algorithm end to end.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildManifest } from '../../scripts/gateway-bundle-manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

// Map a built file's extension to the Content-Type the serve route returns. Only the bytes the
// gateway actually serves (every emitted file under assets/<version>/) need a type; the manifest's
// integrity gate is what makes them safe, the content-type is just correct labelling. Kept narrow +
// explicit (no mime-db dependency) — unknown types fall back to octet-stream rather than guessing.
const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

function contentTypeFor(file) {
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

// ── Entry detection ──────────────────────────────────────────────────────────────
// The /app loader emits <script>/<link> ONLY for the ENTRY chunk(s): the entry JS + its CSS. Lazy
// chunks (xterm, MarketplaceDrawer, …) are fetched on demand by the entry and are protected by the
// serve-time re-verify, NOT browser SRI — so they must NOT appear in the loader.
//
// Vite's index.html is the source of truth for what the entry loads at boot: the build rewrites it to
// reference exactly the entry's <script type="module" src> + its <link rel="stylesheet">. We parse
// those /assets/... references and treat them (and only them) as entry assets. We do NOT enable Vite's
// .vite/manifest.json (the project doesn't emit one) and we NEVER hardcode a hash — the hash is read
// out of the freshly built index.html each run.
//
// Match a root-relative ("/...") src/href ending in .js/.css. Vite emits the entry as
// /assets/index-<hash>.js — the leading "/" is the dist root, so the dist-relative path is the URL
// minus the leading slash (→ "assets/index-<hash>.js", which is where the file actually lives). We
// deliberately don't match protocol-relative or absolute-URL (https://) refs: the fonts <link> in
// index.html is a google-fonts URL and must NOT be treated as a local entry asset.
const ENTRY_ASSET_RE = /(?:src|href)="(\/[^"]+\.(?:js|css))"/g

export function detectEntryUrls(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8')
  const urls = new Set()
  for (const m of html.matchAll(ENTRY_ASSET_RE)) {
    // Strip ONLY the leading "/" → the dist-relative path that buildManifest keys against.
    urls.add(m[1].replace(/^\//, ''))
  }
  if (urls.size === 0) {
    throw new Error(
      `no entry <script>/<link> found in ${join(distDir, 'index.html')} — refusing to ship a ` +
        'bundle whose loader would have nothing to boot'
    )
  }
  return urls
}

// ── Manifest assembly ──────────────────────────────────────────────────────────────
// Build the FULL manifest (every emitted JS/CSS, sha384-pinned) reusing buildManifest, then mark
// which entries are entry-chunks (loader-emitted) vs lazy (serve-verified only). The worker uses
// `isEntry` to decide what goes in the /app loader; it re-verifies ALL entries from R2 regardless.
export function buildShipManifest(distDir, version) {
  const base = buildManifest(distDir, version)
  const entryRel = detectEntryUrls(distDir) // dist-relative paths, e.g. "index-<hash>.js"

  const entries = base.entries.map((e) => {
    // e.url is /assets/<version>/<rel>; strip the versioned prefix to compare with entryRel.
    const rel = e.url.replace(`/assets/${version}/`, '')
    return { ...e, isEntry: entryRel.has(rel) }
  })

  // Sanity: every entry asset named in index.html must exist in the manifest (a JS/CSS file we
  // actually built + pinned). If index.html references something we didn't pin, the loader would
  // emit an unverifiable tag — hard fail rather than ship a broken loader.
  for (const rel of entryRel) {
    const url = `/assets/${version}/${rel}`
    if (!entries.some((e) => e.url === url)) {
      throw new Error(`index.html entry asset ${rel} is not in the built manifest (${url})`)
    }
  }
  if (!entries.some((e) => e.isEntry && e.kind === 'script')) {
    throw new Error('no entry script detected — the loader needs at least one entry JS chunk')
  }

  return { version, entries }
}

// ── R2 upload plan ──────────────────────────────────────────────────────────────
// EVERY file under dist (not just JS/CSS) is served from R2 — the entry pulls fonts, icons, sounds,
// the webmanifest, source maps. So the upload plan walks the whole tree, while the manifest only pins
// JS/CSS (those are the only types the loader/SRI mechanism covers; other types are served as-is but
// still keyed by the immutable versioned path). The plan is the explicit list the owner/CI feeds to
// `wrangler r2 object put` — file on disk -> R2 key -> content-type.
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

export function buildUploadPlan(distDir, version) {
  const files = []
  for (const full of walk(distDir)) {
    const rel = relative(distDir, full).split(sep).join('/')
    files.push({
      // path on the build host (CI passes this to --file)
      file: rel,
      // R2 object key — derives ONLY from the validated version + the dist-relative path, so it can
      // never climb out of assets/<version>/ (matches the gateway's resolveBundlePath keyspace).
      key: `assets/${version}/${rel}`,
      contentType: contentTypeFor(rel),
    })
  }
  files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { version, files }
}

// ── Codegen the worker-anchored manifest module ──────────────────────────────────
// Emit gateway/src/bundle-manifest.generated.ts. This module is the TRUST ROOT: `wrangler deploy`
// bakes it into the worker, the serve route re-verifies every R2 byte against it, and the loader
// emits SRI only from it. It is committed (with a placeholder default) so the worker always typechecks
// + the repo always shows exactly what manifest is anchored for the current release — see the header
// comment in the generated file for the committed-vs-gitignored rationale.
//
// Deterministic: entries are url-sorted (buildManifest already does this) and the file content is a
// pure function of (version, dist bytes). Re-running on the same dist yields a byte-identical file.
//
// Emit SINGLE-quoted string literals to match the project's biome quoteStyle, so a fresh codegen is
// byte-identical to what `biome check` wants — re-running ship-bundle is a true no-op diff, never a
// file biome would then reformat.
function tsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function renderGeneratedModule(manifest) {
  const lines = []
  lines.push(
    '// @generated by gateway/scripts/ship-bundle.mjs — DO NOT EDIT BY HAND.',
    '//',
    '// The WORKER-ANCHORED bundle manifest: the sha384 trust root for one release version. This file',
    '// is baked into the worker by `wrangler deploy`; the serve route (src/bundles.ts) re-verifies',
    '// every byte read from R2 against these pins (502 on mismatch) and the /app loader emits browser',
    '// SRI ONLY for the `isEntry` chunks. The manifest is NEVER read from R2 — a compromised R2 that',
    '// serves different bytes than these pins loses at the serve-time re-verify.',
    '//',
    '// To re-ship: build web/dist, then run',
    '//   node gateway/scripts/ship-bundle.mjs --dist web/dist --version <v>',
    '// which overwrites this file, after which `wrangler deploy` ships the new manifest.',
    '//',
    '// COMMITTED (not gitignored) on purpose: the worker imports it, so it must exist for typecheck +',
    '// `wrangler deploy` even on a fresh checkout; and committing it makes the anchored sha384 set an',
    '// auditable, diffable part of each release (a manifest change shows up in code review). The',
    '// committed default is the test-current manifest so local dev / the test suite have a real module',
    '// to import; CI regenerates it per release before `wrangler deploy`. The gateway falls back to the',
    '// in-worker placeholder (src/bundles.ts) when R2 is unbound or the requested version != this one.',
    '//',
    '// `kind`/`url`/`integrity` are the same fields the serve route re-verifies; `isEntry` marks the',
    '// chunks the /app loader emits with browser SRI (entry js + its css). Lazy chunks (isEntry:false)',
    '// are NOT in the loader — they are fetched on demand and protected only by the serve-time',
    '// re-verify against these same pins. src/bundles.ts BundleManifestEntry carries `isEntry?`.',
    '',
    "import type { BundleManifest } from './bundles.js'",
    ''
  )
  lines.push(`export const GENERATED_BUNDLE_VERSION = ${tsString(manifest.version)} as const`)
  lines.push('')
  lines.push('export const GENERATED_BUNDLE_MANIFEST: BundleManifest = {')
  lines.push(`  version: ${tsString(manifest.version)},`)
  lines.push('  entries: [')
  for (const e of manifest.entries) {
    lines.push('    {')
    lines.push(`      kind: ${tsString(e.kind)},`)
    lines.push(`      url: ${tsString(e.url)},`)
    lines.push(`      integrity: ${tsString(e.integrity)},`)
    lines.push(`      isEntry: ${e.isEntry === true},`)
    lines.push('    },')
  }
  lines.push('  ],')
  lines.push('}')
  lines.push('')
  return `${lines.join('\n')}`
}

// ── Codegen the in-worker BAKED-ASSETS module (Plan B: no R2) ──────────────────────
// Emit gateway/src/bundle-assets.generated.ts with the boot JS/CSS bytes plus narrowly allowed root
// static assets as base64. The worker decodes them at module load and serves CURRENT_VERSION from
// memory. Manifest-pinned JS/CSS are re-verified against SRI; root static assets are allowlisted by
// route because the app references them by stable absolute paths (currently /cli-icons/*).
// Deterministic: a pure function of (version, dist bytes).
const BAKED_ROOT_STATIC_PREFIXES = ['cli-icons/']

export function collectBakedAssets(distDir, manifest) {
  const assets = new Map()
  for (const e of manifest.entries) {
    assets.set(e.url, e.url.replace(`/assets/${manifest.version}/`, ''))
  }
  for (const full of walk(distDir)) {
    const rel = relative(distDir, full).split(sep).join('/')
    if (BAKED_ROOT_STATIC_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
      assets.set(`/${rel}`, rel)
    }
  }
  return [...assets.entries()]
    .map(([url, rel]) => ({ url, rel }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
}

export function renderBakedAssetsModule(distDir, manifest) {
  const lines = []
  lines.push(
    '// @generated by gateway/scripts/ship-bundle.mjs --bake — DO NOT EDIT BY HAND.',
    '//',
    '// Plan B (no R2): the CURRENT_VERSION JS/CSS bytes and allowlisted root static assets shipped',
    '// IN the worker as base64. bundles.ts decodes them once at module load. JS/CSS stay',
    '// re-verified against the worker-anchored manifest; root static assets are route-allowlisted.',
    '// Default (empty) falls through to the v0 placeholder. Re-generate with:',
    '//   node gateway/scripts/ship-bundle.mjs --dist web/dist --version <v> --bake',
    '',
    'export const GENERATED_BUNDLE_ASSETS: Readonly<',
    '  Record<string, { readonly b64: string; readonly contentType: string }>',
    '> = {'
  )
  for (const { url, rel } of collectBakedAssets(distDir, manifest)) {
    const b64 = readFileSync(join(distDir, rel)).toString('base64')
    lines.push(`  ${tsString(url)}: {`)
    lines.push(`    b64: ${tsString(b64)},`)
    lines.push(`    contentType: ${tsString(contentTypeFor(rel))},`)
    lines.push('  },')
  }
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') opts.dist = argv[++i]
    else if (a === '--version') opts.version = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--plan') opts.plan = argv[++i]
    else if (a === '--bake') opts.bake = true
    else throw new Error(`unknown arg: ${a}`)
  }
  return opts
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    process.exit(2)
  }

  const distDir = resolve(repoRoot, opts.dist ?? 'web/dist')
  const version = opts.version
  if (!version) {
    process.stderr.write(
      'usage: node gateway/scripts/ship-bundle.mjs --dist <distDir> --version <v> [--out <file>] [--plan <file>]\n'
    )
    process.exit(2)
  }
  // Guard the version the same way the gateway's VERSION_RE does — refuse to anchor a manifest under
  // a version the serve route would reject anyway.
  if (!/^[A-Za-z0-9._-]+$/.test(version) || version === '.' || version === '..') {
    process.stderr.write(`invalid version segment: ${JSON.stringify(version)}\n`)
    process.exit(2)
  }

  const outPath = resolve(repoRoot, opts.out ?? 'gateway/src/bundle-manifest.generated.ts')

  const manifest = buildShipManifest(distDir, version)
  writeFileSync(outPath, renderGeneratedModule(manifest))

  // --bake: also write the in-worker baked-assets module (Plan B, no R2). The bytes ride the worker
  // deploy; no R2 upload needed. (Without --bake the manifest still expects bytes from R2.)
  if (opts.bake) {
    const bakedPath = resolve(repoRoot, 'gateway/src/bundle-assets.generated.ts')
    const bakedCount = collectBakedAssets(distDir, manifest).length
    writeFileSync(bakedPath, renderBakedAssetsModule(distDir, manifest))
    process.stderr.write(
      `ship-bundle: baked ${bakedCount} files into ${relative(repoRoot, bakedPath)} (Plan B, no R2)\n`
    )
  }

  const plan = buildUploadPlan(distDir, version)
  const planJson = `${JSON.stringify(plan, null, 2)}\n`
  if (opts.plan) {
    writeFileSync(resolve(repoRoot, opts.plan), planJson)
  } else {
    process.stdout.write(planJson)
  }

  // Log the in-repo path when the output lives under the repo (the normal case), else the absolute
  // path — never a ../../.. climb that just obscures where it landed.
  const rel = relative(repoRoot, outPath)
  const shownOut = rel.startsWith('..') ? outPath : rel
  const entryCount = manifest.entries.filter((e) => e.isEntry).length
  process.stderr.write(
    `ship-bundle: wrote ${shownOut} ` +
      `(version=${version}, ${manifest.entries.length} pinned JS/CSS, ${entryCount} entry, ` +
      `${plan.files.length} files to upload)\n`
  )
}
