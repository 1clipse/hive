import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { runHiveCommand } from '../../src/cli/hive.js'

const tempDirs: string[] = []
const originalDataDir = process.env.HIVE_DATA_DIR

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HIVE_DATA_DIR
  else process.env.HIVE_DATA_DIR = originalDataDir
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const setIsolatedDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-shutdown-test-'))
  tempDirs.push(dir)
  process.env.HIVE_DATA_DIR = dir
  return dir
}

const openKeepAliveSocket = async (host: string, port: number): Promise<Socket> => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port })
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
  // Issue a minimal request and explicitly ask the server to keep the
  // socket open. The server-side keep-alive socket is the same kind of
  // resource a browser WebSocket upgrade holds — and it is exactly what
  // `server.close()` waits on indefinitely if we don't force-close.
  socket.write(
    [
      'GET /api/ui/session HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: keep-alive',
      'Accept: application/json',
      '',
      '',
    ].join('\r\n')
  )
  // Wait until we see the response so we know the request finished and
  // the server is now sitting on an idle keep-alive socket.
  await new Promise<void>((resolve, reject) => {
    socket.once('data', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

describe('hive runtime shutdown — open connections', () => {
  test('close() returns promptly even with an upgraded WebSocket client connected', async () => {
    // This is the actual Windows-hang reproduction: a browser tab with
    // /ws/terminal/<runId> or /ws/tasks/<workspaceId> open keeps an
    // upgraded WebSocket socket pinned to the server. `server.close()`
    // waits on that socket; `server.closeAllConnections()` does NOT
    // terminate already-upgraded WS (Node's API only sweeps the HTTP
    // state machine). The runtime hangs until the user `taskkill /F`s
    // it, which also bypasses PTY cleanup.
    //
    // Without an explicit teardown of the WS layer (terminate ws
    // clients + close WebSocketServer) inside the shutdown path, the
    // close awaited below never resolves. We set a tight budget — well
    // below the default vitest timeout — so the regression is loud.
    setIsolatedDataDir()
    const hive = await runHiveCommand(['--port', '0'])
    const baseUrl = `http://127.0.0.1:${hive.port}`
    let socket: WebSocket | undefined
    try {
      // Get a UI session cookie + create a workspace so /ws/tasks/<id>
      // can authenticate and accept the upgrade.
      const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
      const cookie = sessionResponse.headers.get('set-cookie')
      if (!cookie) throw new Error('Expected UI session cookie')
      const workspacePath = mkdtempSync(join(tmpdir(), 'hive-shutdown-ws-workspace-'))
      tempDirs.push(workspacePath)
      const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          autostart_orchestrator: false,
          name: 'Alpha',
          path: workspacePath,
        }),
      })
      const workspace = (await workspaceResponse.json()) as { id: string }
      // Open an authenticated WS upgrade and wait until the server side
      // has accepted it.
      socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hive.port}/ws/tasks/${workspace.id}`, {
          headers: { cookie },
        })
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
      })

      const closeStart = Date.now()
      await hive.close()
      const closeDuration = Date.now() - closeStart
      // Pre-fix: server.close() waits on the WS socket indefinitely
      // (no idle timeout for upgrade-state sockets), so this test ran
      // to the vitest timeout. Post-fix: the WS server teardown
      // terminates the upgrade socket and close() resolves promptly.
      // 1s gives generous slack over the ~30ms observed locally.
      expect(closeDuration).toBeLessThan(1000)
    } finally {
      socket?.terminate()
    }
  }, 15_000)

  test('close() returns promptly even with a held keep-alive socket', async () => {
    setIsolatedDataDir()
    // The user-facing Windows hang: a browser tab open against Hive
    // keeps its WebSocket upgrade sockets pinned to the server. Without
    // forcibly tearing them down, `server.close(cb)` waits for those
    // sockets to go idle — which an active WS never will — so Ctrl+C
    // in the runtime cmd window hangs forever. Windows can't fall back
    // on a graceful kill (no equivalent of SIGTERM) and the only escape
    // is `taskkill /F`, which also bypasses PTY cleanup.
    //
    // We can't fully exercise an authenticated WS upgrade from this
    // layer (workspace + agent + token setup is several hundred lines),
    // but a held keep-alive HTTP socket reproduces the same close()
    // wait surface. With closeAllConnections() in the shutdown path,
    // close() should drain in well under the Node keep-alive timeout
    // (5 seconds by default, 65s if `server.keepAliveTimeout` was ever
    // raised), regardless of whether the client side cooperates.
    const hive = await runHiveCommand(['--port', '0'])
    const socket = await openKeepAliveSocket('127.0.0.1', hive.port)
    try {
      const closeStart = Date.now()
      await hive.close()
      const closeDuration = Date.now() - closeStart
      // 500ms is tight enough to catch any wait-on-socket regression:
      // Node default keep-alive timeout is 5s, an active WS upgrade
      // never returns at all. Local runs measure ~30ms post-fix.
      expect(closeDuration).toBeLessThan(500)
    } finally {
      socket.destroy()
    }
  }, 10_000)
})
