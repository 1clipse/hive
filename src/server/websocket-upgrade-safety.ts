import type { Duplex } from 'node:stream'

import type WebSocket from 'ws'
import type { WebSocketServer } from 'ws'

type UpgradeSocket = Duplex

const logSocketError = (context: string, error: unknown) => {
  console.error(`[hive] ${context}`, error)
}

export const attachRawSocketErrorHandler = (socket: UpgradeSocket, context: string) => {
  const handler = (error: unknown) => logSocketError(`${context} socket error`, error)
  socket.on('error', handler)
  return () => socket.off('error', handler)
}

export const attachWebSocketServerErrorHandler = (wss: WebSocketServer, context: string) => {
  wss.on('error', (error) => logSocketError(`${context} websocket server error`, error))
}

export const attachWebSocketErrorHandler = (socket: WebSocket, context: string) => {
  socket.on('error', (error) => logSocketError(`${context} websocket error`, error))
}

export const rejectWebSocketUpgrade = (socket: UpgradeSocket, status: string) => {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  } catch (error) {
    logSocketError(`failed to reject websocket upgrade with ${status}`, error)
  }
  socket.destroy()
}

export const sendWebSocketMessage = (
  socket: WebSocket,
  payload: string,
  context: string
): boolean => {
  if (socket.readyState !== socket.OPEN) return false
  try {
    socket.send(payload)
    return true
  } catch (error) {
    logSocketError(`${context} send failed`, error)
    return false
  }
}
