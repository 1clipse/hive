#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const reportPath = join(root, 'artifacts', 'cli-compat-report.json')

const run = (command, args, timeoutMs = 10_000) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: error.message })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, stdout, stderr, error: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })

const checkSqlite = () => {
  const db = new DatabaseSync(':memory:')
  try {
    const row = db.prepare('SELECT 1 AS ok').get()
    if (row?.ok !== 1) throw new Error('unexpected sqlite result')
    return { ok: true }
  } finally {
    db.close()
  }
}

const checkNodePty = () =>
  new Promise((resolve) => {
    const pty = require('@lydell/node-pty')
    if (typeof pty.spawn !== 'function') {
      resolve({ ok: false, error: 'node-pty did not export spawn' })
      return
    }
    let output = ''
    const terminal = pty.spawn(process.execPath, ['-e', 'console.log("hive-pty-ok")'], {
      cols: 80,
      rows: 24,
      cwd: root,
      env: process.env,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        terminal.kill()
      } catch {
        // Best-effort cleanup for a failed native check.
      }
      resolve({ ok: false, output, error: 'timeout' })
    }, 10_000)
    terminal.onData((chunk) => {
      output += chunk
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      // Process exit alone leaves ConPTY's pipe worker alive on Windows.
      // Release the probe terminal before allowing this one-shot CLI to finish.
      if (process.platform === 'win32' && !timedOut) terminal.kill()
      resolve({ ok: exitCode === 0 && output.includes('hive-pty-ok'), exitCode, output })
    })
  })

const checkCli = async (name, command) => {
  const result = await run(command, ['--version'], 8_000)
  if (!result.ok) {
    return {
      name,
      command,
      status: result.error?.includes('ENOENT') ? 'not_installed' : 'unverified',
      detail: result.error ?? result.stderr.trim() ?? `exit ${result.code}`,
    }
  }
  return {
    name,
    command,
    status: 'detected',
    version: (result.stdout || result.stderr).trim().split('\n')[0] ?? '',
  }
}

const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  native: {
    node_sqlite: checkSqlite(),
    node_pty: await checkNodePty(),
  },
  tier1_cli: [await checkCli('Claude Code', 'claude'), await checkCli('Codex', 'codex')],
}

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log('# Hive CLI compatibility report')
console.log(`platform: ${report.platform}`)
console.log(`node: ${report.node}`)
console.log(`node:sqlite: ${report.native.node_sqlite.ok ? 'ok' : 'failed'}`)
console.log(`node-pty: ${report.native.node_pty.ok ? 'ok' : 'failed'}`)
for (const cli of report.tier1_cli) {
  console.log(`${cli.name}: ${cli.status}${cli.version ? ` (${cli.version})` : ''}`)
}
console.log(`json: ${reportPath}`)

if (!report.native.node_sqlite.ok || !report.native.node_pty.ok) {
  process.exitCode = 1
}
