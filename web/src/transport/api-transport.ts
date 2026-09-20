// The seam every network call in the web app rides. DirectTransport (desktop, local runtime) IS
// today's behavior; TunnelTransport (mobile, gateway) is the additive mobile impl. Both halves of
// the wire are covered: fetch('/api/*') AND new WebSocket('/ws/*').

/** The SUBSET of the DOM WebSocket API the terminal + tasks clients actually use today
 *  (terminal-client.ts: send/onmessage/onopen/readyState/OPEN/close; useTasksFile: onmessage/close).
 *  TunnelTransport only emulates this much; the native WebSocket structurally satisfies it. */
export interface TransportSocket {
  readonly OPEN: number
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string | ArrayBufferLike | Uint8Array }) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send: (data: string | ArrayBufferLike | ArrayBufferView) => void
  close: (code?: number, reason?: string) => void
}

export interface ApiTransport {
  /** Desktop DirectTransport needs the same-origin UI cookie bootstrap. TunnelTransport authenticates
   *  through the daemon bridge and must never call /api/ui/session. Defaults to true for legacy tests
   *  and any future direct-like transport that does not set it explicitly. */
  requiresUiSession?: boolean

  /** Replaces raw fetch('/api/*'). `path` is a runtime-relative path beginning with '/api/'.
   *  Returns a real Response (Direct) or one reassembled from sealed tunnel frames (Tunnel).
   *  Throws on transport failure (in-flight tunnel drop) exactly like fetch rejects on network loss. */
  fetch(path: string, init?: RequestInit): Promise<Response>

  /** Replaces `new WebSocket(toWebSocketUrl('/ws/...'))`. `path` is a runtime-relative '/ws/...'
   *  path; `params` are the query params the caller baked in (clientId/cols/rows). */
  openWebSocket(path: string, params?: Record<string, number | string | undefined>): TransportSocket
}

/** Connection health for the mobile shell (M5b renders the banner; M5a emits the signal). */
export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'disconnected' | 'revoked'

export interface ConnectionStatus {
  state: ConnectionState
  reason?: string
  nextRetryInMs?: number
  /** Present only for terminal-but-resumable states such as daemon_offline. */
  retry?: () => void
}
