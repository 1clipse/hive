import '../helpers/mock-node-pty.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { createAgentManager } from '../../src/server/agent-manager.js'
import { removeTestPath } from '../helpers/fs-cleanup.js'

const tempDirs: string[] = []

const waitFor = async (assertion: () => void, timeoutMs = 1000, intervalMs = 10) => {
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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    removeTestPath(dir)
  }
})

describe('agent manager (unit)', () => {
  test('starts a PTY process and captures output', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-start`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'print-env.js')
    writeFileSync(
      scriptPath,
      [
        'console.log(process.env.HIVE_PROJECT_ID)',
        'console.log(process.env.HIVE_AGENT_ID)',
        'setTimeout(() => process.exit(0), 10)',
      ].join('\n')
    )

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-1',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        HIVE_PORT: '4010',
        HIVE_PROJECT_ID: 'workspace-1',
        HIVE_AGENT_ID: 'worker-1',
      },
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('exited')
    })

    const snapshot = manager.getRun(run.runId)

    expect(snapshot.status).toBe('exited')
    expect(snapshot.output).toContain('workspace-1')
    expect(snapshot.output).toContain('worker-1')
  })

  test('writes input into the running PTY', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-stdin`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'echo-stdin.js')
    writeFileSync(
      scriptPath,
      [
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => {",
        "  process.stdout.write('IN:' + chunk)",
        '  process.exit(0)',
        '})',
      ].join('\n')
    )

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-2',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        HIVE_PORT: '4010',
        HIVE_PROJECT_ID: 'workspace-2',
        HIVE_AGENT_ID: 'worker-2',
      },
    })

    manager.writeInput(run.runId, 'hello from hive\n')
    await waitFor(() => {
      const snapshot = manager.getRun(run.runId)
      expect(snapshot.output).toContain('IN:hello from hive')
      expect(snapshot.status).toBe('exited')
    })

    const snapshot = manager.getRun(run.runId)

    expect(snapshot.output).toContain('IN:hello from hive')
    expect(snapshot.status).toBe('exited')
  })

  test('rejects input after a stopped PTY is marked inactive', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-stop`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'long-running.js')
    writeFileSync(scriptPath, "process.stdin.resume(); console.log('started')\n")

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-stop',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
    })

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('running')
    })

    manager.stopRun(run.runId)

    expect(() => manager.writeInput(run.runId, 'late input\n')).toThrow(/PTY is not active/)
  })

  test('exposes an output bus that streams PTY chunks to subscribers', async () => {
    const dir = join(tmpdir(), `hive-agent-${Date.now()}-bus`)
    mkdirSync(dir, { recursive: true })
    tempDirs.push(dir)

    const scriptPath = join(dir, 'print-env.js')
    writeFileSync(
      scriptPath,
      ['console.log(process.env.HIVE_PROJECT_ID)', 'setTimeout(() => process.exit(0), 10)'].join(
        '\n'
      )
    )

    const manager = createAgentManager()
    const run = await manager.startAgent({
      agentId: 'worker-3',
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: { HIVE_PROJECT_ID: 'workspace-bus' },
    })
    const received: string[] = []
    manager.getOutputBus().subscribe(run.runId, (chunk) => received.push(chunk))

    await waitFor(() => {
      expect(manager.getRun(run.runId).status).toBe('exited')
      expect(received.join('')).toContain('workspace-bus')
    })
  })

  test('marks a run as error when the PTY emits an error event', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dir = join(tmpdir(), `hive-agent-${Date.now()}-pty-error`)
      mkdirSync(dir, { recursive: true })
      tempDirs.push(dir)

      const scriptPath = join(dir, 'pty-error.js')
      writeFileSync(scriptPath, 'process.stdin.resume();\n')

      const manager = createAgentManager()
      const run = await manager.startAgent({
        agentId: 'worker-error',
        command: process.execPath,
        args: [scriptPath],
        cwd: dir,
      })

      await waitFor(() => {
        const snapshot = manager.getRun(run.runId)
        expect(snapshot.status).toBe('error')
        expect(snapshot.exitCode).toBeNull()
      })
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('PTY error for run'),
        expect.any(Error)
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test.skipIf(process.platform === 'win32')(
    'waits for the exit event when the PTY emits read EIO as EOF',
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const dir = join(tmpdir(), `hive-agent-${Date.now()}-pty-eio-eof`)
        mkdirSync(dir, { recursive: true })
        tempDirs.push(dir)

        const scriptPath = join(dir, 'pty-eio-eof.js')
        writeFileSync(scriptPath, 'process.exit(0)\n')

        const manager = createAgentManager()
        const run = await manager.startAgent({
          agentId: 'worker-eof',
          command: process.execPath,
          args: [scriptPath],
          cwd: dir,
        })

        await waitFor(() => {
          const snapshot = manager.getRun(run.runId)
          expect(snapshot.status).toBe('exited')
          expect(snapshot.exitCode).toBe(0)
        })
        expect(consoleError).not.toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    }
  )

  test.skipIf(process.platform === 'win32')(
    'fails a run if read EIO is not followed by an exit event',
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const dir = join(tmpdir(), `hive-agent-${Date.now()}-pty-eio-hangs`)
        mkdirSync(dir, { recursive: true })
        tempDirs.push(dir)

        const scriptPath = join(dir, 'pty-eio-hangs.js')
        writeFileSync(scriptPath, 'process.stdin.resume();\n')

        const manager = createAgentManager()
        const run = await manager.startAgent({
          agentId: 'worker-eof-hangs',
          command: process.execPath,
          args: [scriptPath],
          cwd: dir,
        })

        await waitFor(
          () => {
            const snapshot = manager.getRun(run.runId)
            expect(snapshot.status).toBe('error')
            expect(snapshot.exitCode).toBeNull()
          },
          2000,
          20
        )
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('PTY read EOF without exit'),
          expect.objectContaining({ code: 'EIO', syscall: 'read' })
        )
      } finally {
        consoleError.mockRestore()
      }
    }
  )
})
