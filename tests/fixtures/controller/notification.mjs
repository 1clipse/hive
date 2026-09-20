// A real child process standing in for Codex; it never contacts an App.
import { appendFileSync, existsSync } from 'node:fs'

if (process.argv.includes('--help')) process.exit(0)
const message = process.argv[process.argv.indexOf('--message') + 1] ?? ''
if (message.includes('controller connection is confirmed')) process.exit(0)
appendFileSync(
  process.env.HIVE_TEST_NOTIFICATION_MARKER,
  `${JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })}\n`
)
const timer = setInterval(() => {
  if (!existsSync(process.env.HIVE_TEST_NOTIFICATION_RELEASE)) return
  clearInterval(timer)
  process.exit(0)
}, 20)
