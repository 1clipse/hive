import type { ApiTransport, TransportSocket } from './api-transport.js'

// Moved verbatim from terminal-client.ts so the desktop terminal + tasks clients share one URL
// builder. ws/wss mirrors http/https; undefined params drop out. Byte-identical to today's output.
const toWebSocketUrl = (
  path: string,
  params: Record<string, number | string | undefined> = {}
): string => {
  const url = new URL(path, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export const directTransport: ApiTransport = {
  requiresUiSession: true,
  fetch(path, init) {
    // global fetch — same-origin against the local runtime, unchanged
    return fetch(path, init)
  },
  openWebSocket(path, params) {
    return new WebSocket(toWebSocketUrl(path, params)) as unknown as TransportSocket
  },
}
