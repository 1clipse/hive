import { describe, expect, test, vi } from 'vitest'

import { taskkillProcessTree } from '../../src/server/agent-manager-support.js'

describe('taskkillProcessTree — Windows process tree cleanup', () => {
  test('invokes taskkill /pid <pid> /t /f on win32', () => {
    const calls: Array<[string, string[]]> = []
    const result = taskkillProcessTree(4242, 'win32', (cmd, args, done) => {
      calls.push([cmd, [...args]])
      done(true)
    })
    // taskkill is the documented Microsoft tool for terminating a
    // process and all its descendants. /t walks the process tree, /f
    // forces termination (skipping the graceful shutdown that
    // pty.kill() can't request from a Windows process anyway).
    expect(result).toBe(true)
    expect(calls).toEqual([['taskkill', ['/pid', '4242', '/t', '/f']]])
  })

  test('is a no-op on POSIX platforms', () => {
    // POSIX runs already kill the process group via `process.kill(-pgid, SIGKILL)`,
    // so taskkill is not needed there. Routing through this helper on
    // every platform keeps the agent-manager-support call site uniform.
    const calls: unknown[] = []
    expect(
      taskkillProcessTree(4242, 'darwin', (...args) => {
        calls.push(args)
      })
    ).toBe(false)
    expect(
      taskkillProcessTree(4242, 'linux', (...args) => {
        calls.push(args)
      })
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('refuses non-positive pids without invoking the runner', () => {
    // pty.pid can be 0 or -1 if the PTY never successfully spawned;
    // we must not feed those to taskkill (it would either fail or,
    // worse, target the wrong process if Windows recycles low pids).
    const calls: unknown[] = []
    expect(
      taskkillProcessTree(0, 'win32', (...args) => {
        calls.push(args)
      })
    ).toBe(false)
    expect(
      taskkillProcessTree(-1, 'win32', (...args) => {
        calls.push(args)
      })
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('swallows runner failures and reports false', () => {
    // taskkill can fail for several reasons:
    //   - the process is already gone (rare given this is the primary
    //     kill path; mostly happens on a second `stop()` call)
    //   - taskkill is missing from PATH (stripped-down container,
    //     Windows Server Core variants)
    //   - access denied (restricted PowerShell / Group Policy)
    // The caller (killPty / scheduleForceKill in agent-manager-support)
    // falls back to pty.kill() when this returns false, so swallowing
    // and reporting the failure is the right contract.
    const result = taskkillProcessTree(4242, 'win32', () => {
      throw new Error('The process "4242" not found.')
    })
    expect(result).toBe(false)
  })

  test('reports asynchronous taskkill failure through the fallback callback', () => {
    const onFailure = vi.fn()
    const result = taskkillProcessTree(
      4242,
      'win32',
      (_cmd, _args, done) => {
        done(false)
      },
      onFailure
    )

    expect(result).toBe(true)
    expect(onFailure).toHaveBeenCalledTimes(1)
  })
})
