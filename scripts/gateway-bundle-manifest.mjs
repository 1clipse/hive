// Build the gateway bundle SRI manifest from a Vite output dir.
//
// Used by .github/workflows/gateway-deploy.yml (upload-bundle job) at release time: it walks the
// built web/dist, computes a sha384 SRI per JS/CSS asset, and emits a manifest in the SAME shape +
// SAME `sha384-<base64>` form the gateway pins and re-verifies (gateway/src/bundles.ts:
// BundleManifest / SRI_RE / verifyAssetIntegrity). The browser then refuses any script whose bytes
// don't match — the gateway half of H-SRI-1.
//
// Usage:  node scripts/gateway-bundle-manifest.mjs <distDir> <version>   (prints JSON to stdout)
//
// Pure helper (sriIntegrity / buildManifest) is exported for tests/unit/gateway-bundle-manifest.test.ts.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// sha384 of the bytes, base64, prefixed `sha384-` — byte-for-byte the form the gateway's SRI_RE
// (/^sha384-[A-Za-z0-9+/]{64}={0,2}$/) accepts and a browser's integrity= attribute enforces. This
// MUST stay sha384-only to match computeSriIntegrity on the gateway side (one algorithm end to end).
export function sriIntegrity(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`
}

// Map a file extension to the manifest `kind`. Only JS and CSS become loader-referenced entries
// (the loader emits <script>/<link> for these); other emitted files (source maps, fonts, images)
// ship as plain assets and aren't SRI-pinned in the loader HTML.
function kindFor(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'script'
  if (file.endsWith('.css')) return 'style'
  return null
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

// Build the manifest object from a dist dir. Deterministic: entries are sorted by url so the same
// build always yields byte-identical manifest JSON (auditable, diffable across releases).
export function buildManifest(distDir, version) {
  const entries = []
  for (const full of walk(distDir)) {
    const kind = kindFor(full)
    if (kind === null) continue
    // POSIX-style relative path under the version, regardless of the build host's separator.
    const rel = relative(distDir, full).split(sep).join('/')
    entries.push({
      kind,
      url: `/assets/${version}/${rel}`,
      integrity: sriIntegrity(readFileSync(full)),
    })
  }
  entries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  return { version, entries }
}

// CLI entry only when run directly (not when imported by the test).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  const [distDir, version] = process.argv.slice(2)
  if (!distDir || !version) {
    process.stderr.write('usage: node scripts/gateway-bundle-manifest.mjs <distDir> <version>\n')
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(buildManifest(distDir, version), null, 2)}\n`)
}
