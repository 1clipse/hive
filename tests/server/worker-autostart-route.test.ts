import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { removeTestPath } from '../helpers/fs-cleanup.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []
const restoreEnv: Array<[string, string | undefined]> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close()
  }
  while (restoreEnv.length > 0) {
    const [key, value] = restoreEnv.pop() ?? ['', undefined]
    if (!key) continue
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of tempDirs.splice(0)) removeTestPath(dir)
})

const makeWorkspacePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-worker-autostart-'))
  tempDirs.push(dir)
  return dir
}

const createWorkspace = async (baseUrl: string, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      autostart_orchestrator: false,
      name: 'WorkerAuto',
      path: makeWorkspacePath(),
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const createCommandPreset = async (baseUrl: string, cookie: string) => {
  const response = await fetch(`${baseUrl}/api/settings/command-presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      display_name: 'Sleeper',
      command: process.execPath,
      args: ['-e', "console.log('worker up'); setInterval(() => {}, 1000)"],
      env: {},
      resume_args_template: null,
      session_id_capture: null,
      yolo_args_template: null,
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const setEnv = (key: string, value: string | undefined) => {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const waitFor = async (assertion: () => void, timeoutMs = 2000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

const writeWindowsCommandShim = (
  binDir: string,
  name: string,
  commandFile: string,
  readyText?: string
) => {
  const scriptPath = join(binDir, `${name}-shim.mjs`)
  writeFileSync(
    scriptPath,
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(commandFile)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n')`,
      ...(readyText ? [`console.log(${JSON.stringify(readyText)})`] : []),
      'setInterval(() => {}, 1000)',
    ].join('\n')
  )
  writeFileSync(
    join(binDir, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
  )
}

describe('POST /api/workspaces/:workspaceId/workers autostart', () => {
  test('creates a worker, binds the selected command preset, and starts its PTY', async () => {
    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)
    const preset = await createCommandPreset(server.baseUrl, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        command_preset_id: preset.id,
        hive_port: '4010',
        name: 'Alice',
        role: 'coder',
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
      status: string
    }
    expect(body.agent_start.ok).toBe(true)
    expect(body.agent_start.error).toBeNull()
    expect(typeof body.agent_start.run_id).toBe('string')
    expect(body.status).toBe('idle')

    const config = server.store.peekAgentLaunchConfig(workspace.id, body.id)
    expect(config).toEqual(
      expect.objectContaining({
        args: ['-e', "console.log('worker up'); setInterval(() => {}, 1000)"],
        command: process.execPath,
        commandPresetId: preset.id,
      })
    )

    const workerRun = server.store
      .listTerminalRuns(workspace.id)
      .find((run) => run.agent_id === body.id)
    expect(workerRun?.run_id).toBe(body.agent_start.run_id)
    if (workerRun) server.store.stopAgentRun(workerRun.run_id)
  })

  test('starts a worker from a full startup command through the user shell', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-'))
    tempDirs.push(binDir, dataDir)
    const shellCommandFile = join(dataDir, 'shell-command.txt')
    const fakeShell = join(binDir, 'fake-zsh')
    writeFileSync(
      fakeShell,
      [
        '#!/bin/sh',
        'last_arg=""',
        'for arg in "$@"; do last_arg="$arg"; done',
        `printf '%s\\n' "$last_arg" > "${shellCommandFile}"`,
        'echo worker custom shell ready',
        'sleep 60',
      ].join('\n')
    )
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)
    const startupCommand = 'custom-aicli --model demo'
    if (process.platform === 'win32') {
      writeWindowsCommandShim(binDir, 'custom-aicli', shellCommandFile, 'worker custom shell ready')
      setEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`)
    }

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        name: 'CustomWorker',
        role: 'coder',
        startup_command: startupCommand,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
    }
    expect(body.agent_start).toMatchObject({ error: null, ok: true })
    expect(typeof body.agent_start.run_id).toBe('string')
    const expectedConfig =
      process.platform === 'win32'
        ? {
            args: ['/d', '/s', '/c', startupCommand],
            command: process.env.ComSpec ?? 'cmd.exe',
          }
        : {
            args: ['-lic', startupCommand],
            command: fakeShell,
          }
    expect(server.store.peekAgentLaunchConfig(workspace.id, body.id)).toMatchObject({
      ...expectedConfig,
      commandPresetId: null,
      interactiveCommand: 'custom-aicli',
      presetAugmentationDisabled: true,
      sessionIdCapture: null,
    })
    await waitFor(() => {
      expect(readFileSync(shellCommandFile, 'utf8')).toBe(`${startupCommand}\n`)
    })
    await waitFor(() => {
      expect(server.store.getLiveRun(body.agent_start.run_id ?? '').output).toContain(
        'worker custom shell ready'
      )
    })

    if (body.agent_start.run_id) server.store.stopAgentRun(body.agent_start.run_id)
  })

  test('custom OpenCode startup command exposes the OpenCode terminal input profile', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'hive-worker-opencode-profile-bin-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-opencode-profile-'))
    tempDirs.push(binDir, dataDir)
    const shellCommandFile = join(dataDir, 'shell-command.txt')
    const fakeShell = join(binDir, 'fake-zsh')
    writeFileSync(
      fakeShell,
      [
        '#!/bin/sh',
        'last_arg=""',
        'for arg in "$@"; do last_arg="$arg"; done',
        `printf '%s\\n' "$last_arg" > "${shellCommandFile}"`,
        'sleep 60',
      ].join('\n')
    )
    chmodSync(fakeShell, 0o755)
    setEnv('SHELL', fakeShell)
    if (process.platform === 'win32') {
      writeWindowsCommandShim(binDir, 'opencode', shellCommandFile)
      setEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`)
    }

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        command_preset_id: 'opencode',
        name: 'OpenCodeWorker',
        role: 'coder',
        startup_command: 'opencode --continue',
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
    }
    expect(body.agent_start).toMatchObject({ error: null, ok: true })
    const expectedConfig =
      process.platform === 'win32'
        ? {
            args: ['/d', '/s', '/c', 'opencode --continue'],
            command: process.env.ComSpec ?? 'cmd.exe',
          }
        : {
            command: fakeShell,
          }
    expect(server.store.peekAgentLaunchConfig(workspace.id, body.id)).toMatchObject({
      ...expectedConfig,
      commandPresetId: null,
      interactiveCommand: 'opencode',
      presetAugmentationDisabled: true,
    })
    await waitFor(() => {
      expect(readFileSync(shellCommandFile, 'utf8')).toBe('opencode --continue\n')
    })

    const runsResponse = await fetch(`${server.baseUrl}/api/ui/workspaces/${workspace.id}/runs`, {
      headers: { cookie },
    })
    expect(runsResponse.status).toBe(200)
    const runs = (await runsResponse.json()) as Array<{
      run_id: string
      terminal_input_profile: string
    }>
    expect(runs).toContainEqual(
      expect.objectContaining({
        run_id: body.agent_start.run_id,
        terminal_input_profile: 'opencode',
      })
    )

    if (body.agent_start.run_id) server.store.stopAgentRun(body.agent_start.run_id)
  })

  test('custom worker startup command reports the missing executable, not the shell', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hive-worker-custom-start-missing-'))
    tempDirs.push(dataDir)
    setEnv('SHELL', '/bin/sh')

    const server = await startTestServer({ dataDir })
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = await createWorkspace(server.baseUrl, cookie)
    const missingCommand = 'definitely-missing-hive-agent --serve'

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        autostart: true,
        command_preset_id: 'claude',
        name: 'MissingCustomAgent',
        role: 'coder',
        startup_command: missingCommand,
      }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      agent_start: { ok: boolean; error: string | null; run_id: string | null }
      id: string
    }
    expect(body.agent_start).toMatchObject({
      error:
        process.platform === 'win32'
          ? 'definitely-missing-hive-agent failed to start (exit 1)'
          : 'definitely-missing-hive-agent CLI not found in PATH',
      ok: false,
    })
    expect(body.agent_start.error).not.toContain('/bin/sh')
    if (body.agent_start.run_id) server.store.stopAgentRun(body.agent_start.run_id)
  })
})
