import { randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

export const openRawWebSocket = async (baseUrl: string, path: string, cookie: string) => {
  const { hostname, port } = new URL(baseUrl)
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(Number(port), hostname)
    let settled = false
    let response = ''
    let timeout: ReturnType<typeof setTimeout>
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      reject(error)
    }
    timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for websocket upgrade response: ${path}`))
    }, 3000)
    socket.once('error', fail)
    socket.once('connect', () => {
      const key = randomBytes(16).toString('base64')
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${hostname}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Cookie: ${cookie}`,
          '',
          '',
        ].join('\r\n')
      )
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      if (!response.includes('\r\n\r\n')) return
      if (!response.startsWith('HTTP/1.1 101 ')) {
        fail(new Error(`Expected websocket upgrade to succeed, got: ${response.split('\r\n')[0]}`))
        return
      }
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.off('error', fail)
      socket.on('error', () => {})
      resolve(socket)
    })
  })
}

export const writeRsv2Rsv3MalformedFrame = (socket: Socket) => {
  // FIN + RSV2 + RSV3 + text opcode, masked zero-length payload. This is the
  // protocol-error frame behind WS_ERR_UNEXPECTED_RSV_2_3 in issue #18.
  socket.write(Buffer.from([0xb1, 0x80, 0x00, 0x00, 0x00, 0x00]))
}
