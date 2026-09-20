// Shared (key, nonce) dedup recorder for the M6.1 no-nonce-reuse regression tests (A5/B1/D1).
//
// NOT a mock. It observes the REAL key bytes and the REAL frame header that the production seal
// path actually used, recomputes the REAL nonce via the production buildNonce, and records the
// tuple. The whole point of the regression is to PROVE that no (key, nonce) tuple repeats across
// the full connection lifecycle — including a page reload that rebuilds a fresh sealer (seq 0) over
// the same persisted root. If the rekey is removed (root used directly as the AEAD key), the two
// reload Hellos collide on (rootP2d, nonce(p2d, 0, 0)) and dupes() goes positive.

import { buildNonce, type Direction } from '../../src/shared/remote-crypto.js'

// Header field offsets — must match remote-protocol.ts encodeHeader: streamId@4, seq@8 (u32be).
const HEADER_OFF_STREAM_ID = 4
const HEADER_OFF_SEQ = 8

function hex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function readU32be(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off)
}

export interface SealRecord {
  /** the AEAD key actually handed to sealNext (a connKey if the rekey is live; a root if it's not) */
  key: Uint8Array
  direction: Direction
  /** the 12-byte frame header (streamId/seq read out of these bytes — the crypto single source) */
  headerBytes: Uint8Array
}

export interface SealRecorder {
  /** Record one seal. Reads streamId/seq from the real header and computes the real nonce. */
  record(rec: SealRecord): void
  /** Number of duplicate (key, nonce) tuples = total seals - distinct tuples. 0 ⇒ no reuse. */
  dupes(): number
  /** Total seals recorded (sanity: assert this is > 0 so a no-op recorder can't pass vacuously). */
  count(): number
  /** Distinct (key, nonce) tuples seen. */
  tuples(): string[]
  /**
   * Distinct AEAD keys (hex) seen across all seals in a given direction. A reload over ONE root must
   * still show TWO distinct connKeys (one per connection) — if a test accidentally regenerates the
   * root, the keys also differ but for the wrong reason, so the no-dupes check alone can pass
   * vacuously. Pairing this with a "the two connections used different keys" assertion guards against
   * that false pass; on the pre-fix code (root used directly) it collapses to ONE key and the (key,
   * nonce) tuple repeats, so dupes() bites.
   */
  keys(direction: Direction): string[]
}

export function createSealRecorder(): SealRecorder {
  const seen: string[] = []
  const keysByDir = new Map<Direction, Set<string>>()
  return {
    record(rec) {
      const streamId = readU32be(rec.headerBytes, HEADER_OFF_STREAM_ID)
      const seq = readU32be(rec.headerBytes, HEADER_OFF_SEQ)
      const nonce = buildNonce(rec.direction, streamId, seq)
      seen.push(`${hex(rec.key)}|${hex(nonce)}`)
      const set = keysByDir.get(rec.direction) ?? new Set<string>()
      set.add(hex(rec.key))
      keysByDir.set(rec.direction, set)
    },
    dupes() {
      return seen.length - new Set(seen).size
    },
    count() {
      return seen.length
    },
    tuples() {
      return [...seen]
    },
    keys(direction) {
      return [...(keysByDir.get(direction) ?? new Set<string>())]
    },
  }
}
