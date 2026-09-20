import { type ExecFileOptions, execFile } from 'node:child_process'

import { type FsProbeResponse, probeDirectory } from './fs-browse.js'

// macOS Cocoa returns -1743 when the user clicks Cancel in `choose folder`.
// osascript maps that to exit code 1 with the message on stderr.
const MACOS_CANCEL_PATTERNS = [/-128/, /-1743/, /user canceled/i, /execution error/i]
// zenity documents exit code 1 on Cancel. kdialog uses exit code 1 as well.
const LINUX_CANCEL_EXIT_CODES = new Set([1])
// Cap how long we'll wait for a single picker invocation. A reasonable
// modal-dialog dwell time is well under this — the cap exists to catch
// genuinely wedged pickers (PowerShell startup hang under restricted
// execution policy, zenity hung on a missing DBus, osascript blocked on
// the macOS Accessibility prompt) so the HTTP request returns instead
// of pinning a connection forever.
const PICKER_TIMEOUT_MS = 5 * 60 * 1000

type SpawnResult = {
  stderr: string
  stdout: string
  status: number | null
  signal: string | null
  timedOut: boolean
  spawnError: NodeJS.ErrnoException | null
}

export type RunPickCommand = (
  command: string,
  args: string[],
  options: ExecFileOptions
) => Promise<SpawnResult>

export interface PickFolderOptions {
  now?: () => number
  platform?: NodeJS.Platform
  runCommand?: RunPickCommand
}

export interface PickFolderResponse {
  canceled: boolean
  error: string | null
  path: string | null
  probe: FsProbeResponse | null
  supported: boolean
}

interface ExecFileError extends NodeJS.ErrnoException {
  killed?: boolean
  signal?: NodeJS.Signals | null
}

const defaultRunCommand: RunPickCommand = (command, args, options) =>
  new Promise<SpawnResult>((resolve) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const errno = error as ExecFileError | null
      const timedOut = !!errno?.killed && errno?.signal === 'SIGTERM'
      // execFile surfaces ENOENT when the binary is missing; keep the raw errno
      // so the caller can distinguish "command not installed" from "user cancel".
      resolve({
        stderr: String(stderr ?? ''),
        stdout: String(stdout ?? ''),
        status: typeof errno?.code === 'number' ? errno.code : (child.exitCode ?? 0),
        signal: typeof errno?.signal === 'string' ? errno.signal : null,
        spawnError:
          errno && typeof errno.code === 'string' ? (errno as NodeJS.ErrnoException) : null,
        timedOut,
      })
    })
  })

const emptyResponse = (overrides: Partial<PickFolderResponse> = {}): PickFolderResponse => ({
  canceled: false,
  error: null,
  path: null,
  probe: null,
  supported: true,
  ...overrides,
})

const finalizeWithProbe = async (path: string): Promise<PickFolderResponse> => {
  // The OS-native folder picker is itself a user-authorization surface
  // — sandboxing again here would reject any drive other than the one
  // hosting `$HOME` (a common Windows case: `D:\projects`, `E:\code`).
  // The in-browser FS tree (fs-browse.ts:browseDirectory) keeps its
  // own sandbox; only the native picker bypasses it.
  const probe = await probeDirectory(path, { enforceSandbox: false })
  if (!probe.ok || !probe.is_dir) {
    return emptyResponse({
      error: 'Selected path is not a directory.',
      path,
      probe,
    })
  }
  return emptyResponse({ path: probe.path, probe })
}

const macOsPick = async (run: RunPickCommand): Promise<PickFolderResponse> => {
  const script = 'POSIX path of (choose folder with prompt "Select Hive workspace")'
  const result = await run('osascript', ['-e', script], { timeout: PICKER_TIMEOUT_MS })

  if (result.spawnError?.code === 'ENOENT') {
    return emptyResponse({ error: 'osascript is unavailable on this host.', supported: false })
  }
  if (result.timedOut) {
    return emptyResponse({ error: 'Folder picker timed out before a folder was selected.' })
  }
  const combinedStderr = result.stderr.toLowerCase()
  if (result.status !== 0) {
    if (MACOS_CANCEL_PATTERNS.some((re) => re.test(combinedStderr))) {
      return emptyResponse({ canceled: true })
    }
    // Any non-zero exit code without stdout is treated as cancel rather than a
    // hard failure — the user is just closing the dialog.
    if (result.stdout.trim().length === 0) return emptyResponse({ canceled: true })
  }
  const picked = result.stdout.trim().replace(/\/$/, '')
  if (picked.length === 0) return emptyResponse({ canceled: true })
  return finalizeWithProbe(picked)
}

const linuxPick = async (run: RunPickCommand): Promise<PickFolderResponse> => {
  const result = await run(
    'zenity',
    ['--file-selection', '--directory', '--title=Select Hive workspace'],
    { timeout: PICKER_TIMEOUT_MS }
  )
  if (result.spawnError?.code === 'ENOENT') {
    return emptyResponse({
      error: 'zenity not installed. Install zenity or use Advanced: paste path.',
      supported: false,
    })
  }
  if (result.timedOut) {
    return emptyResponse({ error: 'Folder picker timed out before a folder was selected.' })
  }
  if (result.status !== 0 && LINUX_CANCEL_EXIT_CODES.has(result.status ?? 0)) {
    return emptyResponse({ canceled: true })
  }
  const picked = result.stdout.trim()
  if (picked.length === 0) return emptyResponse({ canceled: true })
  return finalizeWithProbe(picked)
}

export const pickFolder = async (options: PickFolderOptions = {}): Promise<PickFolderResponse> => {
  const platform = options.platform ?? process.platform
  const run = options.runCommand ?? defaultRunCommand

  if (platform === 'darwin') return macOsPick(run)
  if (platform === 'linux') return linuxPick(run)
  if (platform === 'win32') {
    return emptyResponse({
      error:
        'Native folder picker is disabled on Windows. Use Browse server filesystem or paste path.',
      supported: false,
    })
  }
  return emptyResponse({
    error: 'Native folder picker not supported on this platform. Use Advanced: paste path.',
    supported: false,
  })
}
