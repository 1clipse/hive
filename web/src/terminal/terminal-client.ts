import { getApiTransport } from '../api.js'
import type { TransportSocket } from '../transport/api-transport.js'

type TerminalControlServerMessage =
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'restore'; snapshot: string }

const INVALID_CONTROL_MESSAGE = 'Invalid terminal control message'

const parseControlMessage = (data: string | ArrayBufferLike | Uint8Array) => {
  let raw: unknown
  try {
    raw = JSON.parse(String(data))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const message = raw as { code?: unknown; message?: unknown; snapshot?: unknown; type?: unknown }
  if (message.type === 'error' && typeof message.message === 'string') {
    return { type: 'error', message: message.message } satisfies TerminalControlServerMessage
  }
  if (message.type === 'exit' && (message.code === null || typeof message.code === 'number')) {
    return { type: 'exit', code: message.code } satisfies TerminalControlServerMessage
  }
  if (message.type === 'restore' && typeof message.snapshot === 'string') {
    return { type: 'restore', snapshot: message.snapshot } satisfies TerminalControlServerMessage
  }
  return null
}

interface TerminalClientOptions {
  initialSize?: {
    cols: number
    pixelHeight?: number
    pixelWidth?: number
    rows: number
  }
  onError: (message: string) => void
  onExit: (code: number | null) => void
  onOutput: (chunk: string, acknowledge: (bytes: number) => void) => void
  onRestore: (snapshot: string, onComplete: () => void) => void
  /**
   * Either underlying socket closed while this client was NOT deliberately disposed — i.e. a tunnel
   * reconnect (frame-mux resetAll -> _remoteClose) or a dropped same-origin ws. Fires AT MOST ONCE per
   * client so the caller can remount and take a FRESH snapshot (VULN-RELIABILITY-2). A dispose() never
   * fires it: a deliberate teardown is not a reconnect signal.
   */
  onClose?: () => void
  runId: string
}

export interface TerminalClient {
  dispose: () => void
  resize: (cols: number, rows: number, pixelWidth?: number, pixelHeight?: number) => void
  sendBinaryInput: (chunk: string) => void
  sendInput: (chunk: string) => void
}

export const createTerminalClient = ({
  initialSize,
  onError,
  onExit,
  onOutput,
  onRestore,
  onClose,
  runId,
}: TerminalClientOptions): TerminalClient => {
  const clientId = crypto.randomUUID()
  const connectionParams = { ...initialSize, clientId }
  const transport = getApiTransport()
  const ioSocket: TransportSocket = transport.openWebSocket(
    `/ws/terminal/${runId}/io`,
    connectionParams
  )
  const controlSocket: TransportSocket = transport.openWebSocket(
    `/ws/terminal/${runId}/control`,
    connectionParams
  )
  let restored = false
  let disposed = false
  let closeSurfaced = false
  const pendingOutput: Array<{ chunk: string; acknowledge: (bytes: number) => void }> = []
  let pendingResize: {
    cols: number
    rows: number
    pixelWidth?: number
    pixelHeight?: number
  } | null = null

  // Either MuxSocket/ws closing while we did NOT dispose() means the tunnel dropped the stream (a
  // network switch / lock screen drives frame-mux.resetAll -> _remoteClose). Surface it once so the
  // caller can remount and pull a fresh snapshot (VULN-RELIABILITY-2): the same dead socket can never
  // re-run attachControl, so without a remount the pane freezes and output never resumes.
  const surfaceClose = (): void => {
    if (disposed || closeSurfaced) return
    closeSurfaced = true
    onClose?.()
  }
  ioSocket.onclose = surfaceClose
  controlSocket.onclose = surfaceClose

  const sendResize = () => {
    if (!pendingResize || controlSocket.readyState !== controlSocket.OPEN) return
    controlSocket.send(JSON.stringify({ type: 'resize', ...pendingResize }))
    pendingResize = null
  }

  ioSocket.onmessage = (event) => {
    const chunk = typeof event.data === 'string' ? event.data : ''
    const acknowledge = (bytes: number) => {
      if (controlSocket.readyState !== controlSocket.OPEN) return
      controlSocket.send(JSON.stringify({ type: 'output_ack', bytes }))
    }
    if (!restored) {
      pendingOutput.push({ chunk, acknowledge })
      return
    }
    onOutput(chunk, acknowledge)
  }
  controlSocket.onopen = () => {
    sendResize()
  }
  controlSocket.onmessage = (event) => {
    const message = parseControlMessage(event.data)
    if (!message) {
      onError(INVALID_CONTROL_MESSAGE)
      return
    }
    if (message.type === 'exit') onExit(message.code)
    if (message.type === 'error') onError(message.message)
    if (message.type === 'restore') {
      let restoreCompleted = false
      const completeRestore = () => {
        if (restoreCompleted) return
        restoreCompleted = true
        restored = true
        if (controlSocket.readyState === controlSocket.OPEN) {
          controlSocket.send(JSON.stringify({ type: 'restore_complete' }))
        }
        for (const output of pendingOutput.splice(0)) {
          onOutput(output.chunk, output.acknowledge)
        }
      }
      onRestore(message.snapshot, completeRestore)
    }
  }

  return {
    dispose() {
      disposed = true
      ioSocket.close()
      controlSocket.close()
    },
    resize(cols, rows, pixelWidth, pixelHeight) {
      pendingResize = { cols, rows }
      if (pixelWidth !== undefined) pendingResize.pixelWidth = pixelWidth
      if (pixelHeight !== undefined) pendingResize.pixelHeight = pixelHeight
      sendResize()
    },
    sendBinaryInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      const bytes = new Uint8Array(chunk.length)
      for (let index = 0; index < chunk.length; index++) {
        bytes[index] = chunk.charCodeAt(index) & 0xff
      }
      ioSocket.send(bytes)
    },
    sendInput(chunk) {
      if (ioSocket.readyState !== ioSocket.OPEN) return
      ioSocket.send(chunk)
    },
  }
}
