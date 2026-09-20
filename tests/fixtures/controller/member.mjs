// Deterministic protocol participant in a real PTY; no model or PTY mocking.
import { execFileSync } from 'node:child_process'

const seen = new Set()
let buffer = ''
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  if (!buffer.includes('</hive-message>')) return
  for (const match of buffer.matchAll(/dispatch_id: ([0-9a-f-]{36})/g)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    if (buffer.includes('HOLD_FOR_CANCEL')) continue
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        process.argv[2],
        process.argv[3],
        'report',
        'CONTROLLER_PTY_RESULT',
        '--dispatch',
        id,
      ],
      { env: process.env, encoding: 'utf8' }
    )
    process.stdout.write(`${output}\nMEMBER_READY> `)
  }
  buffer = ''
})
process.stdout.write('MEMBER_READY> ')
