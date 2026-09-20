import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const integrationRoot = fileURLToPath(new URL('../', import.meta.url))

export async function runBrowserTask(input, options = {}) {
  if (input.allow_execution !== true)
    throw new Error('allow_execution=true is required; no browser action was executed.')
  if (
    ![input.expect_url_contains, input.expect_title_contains, input.expect_text_contains].some(
      Boolean
    )
  ) {
    throw new Error(
      'At least one independent expected outcome is required; no browser action was executed.'
    )
  }
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP(S) browser tasks are allowed.')
  const python =
    options.python ??
    process.env.HIVE_JEV_PYTHON ??
    (process.platform === 'win32' ? 'python.exe' : 'python3')
  const runner = options.runner ?? path.join(integrationRoot, 'scripts', 'browser-run.py')
  const payload = {
    ...input,
    allowed_origins: input.allowed_origins?.length
      ? input.allowed_origins.map((origin) => new URL(origin).origin)
      : [url.origin],
  }

  return new Promise((resolve, reject) => {
    const child = spawn(python, [runner], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HIVE_JEV_BROWSER_EXECUTION: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(
        new Error('Browser task timed out; the runner was stopped without retrying an action.')
      )
    }, options.timeoutMs ?? 120_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim().split(/\r?\n/u).at(-1) || `Browser runner exited with code ${code}.`
          )
        )
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('Browser runner returned invalid JSON.'))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}
