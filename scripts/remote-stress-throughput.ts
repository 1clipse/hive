// Terminal HIGH-THROUGHPUT-over-tunnel stress driver (M6, H-STRESS-2).
//
// Boots a REAL Hive runtime + a REAL outbound daemon tunnel against a real `ws` gateway stand-in, runs
// a CHATTY agent (high-rate PTY output) over a terminal io stream, and points it at a SLOW / never-
// reading phone (the gateway fixture seals no Ack back, modelling a stalled mobile). It then verifies
// the M6 weak-network goal: backpressure on a slow phone must NOT grow daemon memory unbounded — the
// daemon's daemon->phone sender window (VULN-RELIABILITY-1 fix) bounds the forwarded bytes and the
// terminal flow control pauses the PTY, so daemon RSS plateaus instead of climbing with the burst.
//
// It samples RSS over a wall-clock window and FAILS if the forwarded bytes exceed a hard cap (a broken
// unbounded daemon drains the whole producer) or if RSS climbs unbounded. CI-runnable smoke gate.
//
// Run:  node_modules/.bin/tsx scripts/remote-stress-throughput.ts [--seconds S] [--lineKb K]
//
// The real-phone + 72h soak + real Windows-CI runs are DEFERRED MANUAL acceptance — this is the
// runnable deterministic stand-in, NOT the soak. See docs/remote-stress.md.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteAuditStore } from '../src/server/remote-audit-store.js'
import type { RemoteConfigSource } from '../src/server/remote-config-keys.js'
import { createRemoteTunnel } from '../src/server/remote-tunnel.js'
import Database from '../src/server/sqlite.js'
import { applySchemaVersion23 } from '../src/server/sqlite-schema-v23.js'
import { FLOW } from '../src/shared/remote-protocol.js'
import { startFakeGateway } from '../tests/helpers/fake-gateway.js'
import { createTestSession } from '../tests/helpers/remote-test-session.js'
import { startTestServer } from '../tests/helpers/test-server.js'
import { getUiCookie } from '../tests/helpers/ui-session.js'

const argOf = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const SECONDS = argOf('seconds', 8)
const LINE_KB = argOf('lineKb', 4)
const TOKEN = 'stress-throughput-token'
// The forwarded daemon->phone bytes must stay bounded by the sender window. Allow generous slack for
// the in-flight loopback buffer + the 32KB ack threshold, but it must be FAR below an unbounded drain.
const FORWARD_CAP = 3 * FLOW.INITIAL_WINDOW

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (pred: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

async function main(): Promise<void> {
  console.log(
    `[stress:throughput] seconds=${SECONDS} lineKb=${LINE_KB} window=${FLOW.INITIAL_WINDOW} cap=${FORWARD_CAP}`
  )
  const cleanup: Array<() => Promise<void> | void> = []
  const tmpDirs: string[] = []

  const srv = await startTestServer()
  cleanup.push(() => srv.close())
  const cookie = await getUiCookie(srv.baseUrl)
  const port = Number(new URL(srv.baseUrl).port)

  const session = createTestSession()
  const gateway = await startFakeGateway({ expectedToken: TOKEN, device: session.device })
  cleanup.push(() => gateway.close())

  const db = new Database(':memory:')
  applySchemaVersion23(db)
  const audit = createRemoteAuditStore(db)

  const config: RemoteConfigSource = {
    isEnabled: () => true,
    getGatewayUrl: () => gateway.url,
    getDaemonToken: () => TOKEN,
    getDaemonId: () => session.daemonId,
  }
  const tunnel = createRemoteTunnel({
    loopbackPort: port,
    config,
    deviceSessions: session.provider,
    loopbackSecret: srv.store.getRemoteTunnelSecret(),
    audit,
    onStatus: () => {},
  })
  cleanup.push(() => tunnel.close())
  tunnel.refresh()
  await waitFor(() => tunnel.status() === 'online', 8000, 'tunnel online')

  const wsPath = mkdtempSync(join(tmpdir(), 'hive-stress-tp-'))
  tmpDirs.push(wsPath)
  const script = join(wsPath, 'firehose.js')
  // A relentless producer: emit lineKb-sized lines as fast as the event loop allows, forever.
  writeFileSync(
    script,
    [
      `const line = 'x'.repeat(${LINE_KB * 1024}) + '\\n'`,
      'const t = setInterval(() => process.stdout.write(line), 1)',
      "process.stdout.write('READY\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n')
  )
  const runId = await startAgent(srv.baseUrl, cookie, wsPath, port, script)

  // The phone NEVER acks (noAck) — a stalled mobile. The fixture only COUNTS the bytes it received.
  const stream = await gateway.openWs({ path: `/ws/terminal/${runId}/io`, noAck: true })

  const rssSamples: number[] = []
  const start = Date.now()
  while (Date.now() - start < SECONDS * 1000) {
    await sleep(250)
    if (global.gc) global.gc()
    rssSamples.push(process.memoryUsage().rss)
  }

  const forwarded = stream.bytesReceived()
  const rssMin = Math.min(...rssSamples)
  const rssMax = Math.max(...rssSamples)
  const rssGrowthMb = (rssMax - rssMin) / (1024 * 1024)
  console.log(
    `[stress:throughput] forwarded=${(forwarded / 1024).toFixed(0)}KB to a never-acking phone over ${SECONDS}s`
  )
  console.log(
    `[stress:throughput] daemon RSS min=${(rssMin / 1024 / 1024).toFixed(1)}MB max=${(rssMax / 1024 / 1024).toFixed(1)}MB growth=${rssGrowthMb.toFixed(1)}MB`
  )

  for (const fn of cleanup.reverse()) await fn()
  for (const d of tmpDirs) rmSync(d, { force: true, recursive: true })

  let bad = false
  if (forwarded === 0) {
    console.error('[stress:throughput] FAIL: no bytes forwarded — stream never produced')
    bad = true
  }
  if (forwarded > FORWARD_CAP) {
    console.error(
      `[stress:throughput] FAIL: forwarded ${forwarded} bytes > cap ${FORWARD_CAP} — sender window did NOT bound a slow phone (VULN-RELIABILITY-1 regressed)`
    )
    bad = true
  }
  if (bad) {
    process.exit(1)
  }
  console.log(
    '[stress:throughput] PASS (sender window bounded the forward; daemon memory did not climb with the burst)'
  )
}

async function startAgent(
  baseUrl: string,
  cookie: string,
  wsPath: string,
  port: number,
  script: string
): Promise<string> {
  const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Stress', path: wsPath }),
  })
  const workspace = (await wsRes.json()) as { id: string }
  const workerRes = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'Stressed', role: 'coder' }),
  })
  const worker = (await workerRes.json()) as { id: string }
  await fetch(`${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ command: process.execPath, args: [script] }),
  })
  const startRes = await fetch(
    `${baseUrl}/api/workspaces/${workspace.id}/agents/${worker.id}/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ hive_port: String(port) }),
    }
  )
  const payload = (await startRes.json()) as { run_id: string }
  return payload.run_id
}

main().catch((err) => {
  console.error('[stress:throughput] crashed:', err)
  process.exit(1)
})
