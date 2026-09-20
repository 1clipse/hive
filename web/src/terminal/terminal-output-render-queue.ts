const TERMINAL_OUTPUT_MIN_RENDER_INTERVAL_MS = 50
const TERMINAL_OUTPUT_WRITE_ACK_TIMEOUT_MS = 1000

type AcknowledgeTerminalOutput = (bytes: number) => void

interface TerminalOutputRenderQueueOptions {
  canRender: () => boolean
  write: (chunk: string, callback: () => void) => void
}

export interface TerminalOutputRenderQueue {
  dispose: () => void
  enqueue: (chunk: string, bytes: number, acknowledge: AcknowledgeTerminalOutput) => void
  flush: () => void
}

export const createTerminalOutputRenderQueue = ({
  canRender,
  write,
}: TerminalOutputRenderQueueOptions): TerminalOutputRenderQueue => {
  let disposed = false
  let flushTimer: number | undefined
  let lastFlushAt: number | null = null
  let pendingAcknowledge: AcknowledgeTerminalOutput | undefined
  let pendingAckBytes = 0
  let pendingChunks: string[] = []
  let writeTimer: number | undefined
  let writeGeneration = 0
  let writing = false

  function hasPendingOutput() {
    return pendingAckBytes > 0 || pendingChunks.length > 0
  }

  function clearFlushTimer() {
    if (flushTimer === undefined) return
    window.clearTimeout(flushTimer)
    flushTimer = undefined
  }

  function clearWriteTimer() {
    if (writeTimer === undefined) return
    window.clearTimeout(writeTimer)
    writeTimer = undefined
  }

  function acknowledge(acknowledgeOutput: AcknowledgeTerminalOutput | undefined, bytes: number) {
    if (!acknowledgeOutput || bytes <= 0) return
    acknowledgeOutput(bytes)
  }

  function acknowledgePendingBytes() {
    const bytes = pendingAckBytes
    const acknowledgeOutput = pendingAcknowledge
    pendingAckBytes = 0
    pendingAcknowledge = undefined
    acknowledge(acknowledgeOutput, bytes)
  }

  function scheduleFlush() {
    if (disposed || writing || flushTimer !== undefined || !hasPendingOutput()) return
    const delay =
      lastFlushAt === null
        ? 0
        : Math.max(0, TERMINAL_OUTPUT_MIN_RENDER_INTERVAL_MS - (Date.now() - lastFlushAt))
    if (delay === 0) {
      flushPendingOutput()
      return
    }
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined
      flushPendingOutput()
    }, delay)
  }

  function flushPendingOutput() {
    clearFlushTimer()
    if (disposed || writing || !hasPendingOutput()) return
    if (!canRender()) {
      acknowledgePendingBytes()
      return
    }

    const chunk = pendingChunks.join('')
    const bytes = pendingAckBytes
    const acknowledgeOutput = pendingAcknowledge
    pendingChunks = []
    pendingAckBytes = 0
    pendingAcknowledge = undefined
    lastFlushAt = Date.now()

    if (chunk.length === 0) {
      acknowledge(acknowledgeOutput, bytes)
      scheduleFlush()
      return
    }

    writing = true
    const generation = ++writeGeneration
    const completeWrite = () => {
      if (!writing || generation !== writeGeneration) return
      clearWriteTimer()
      writing = false
      acknowledge(acknowledgeOutput, bytes)
      scheduleFlush()
    }
    writeTimer = window.setTimeout(completeWrite, TERMINAL_OUTPUT_WRITE_ACK_TIMEOUT_MS)
    try {
      write(chunk, completeWrite)
    } catch {
      completeWrite()
    }
  }

  return {
    dispose() {
      disposed = true
      clearFlushTimer()
      clearWriteTimer()
      pendingChunks = []
      pendingAckBytes = 0
      pendingAcknowledge = undefined
    },
    enqueue(chunk, bytes, acknowledgeOutput) {
      if (disposed) return
      if (chunk.length === 0) {
        acknowledge(acknowledgeOutput, bytes)
        return
      }
      if (chunk.length > 0) pendingChunks.push(chunk)
      if (canRender()) {
        pendingAckBytes += bytes
        pendingAcknowledge = acknowledgeOutput
      } else {
        acknowledge(acknowledgeOutput, bytes)
      }
      scheduleFlush()
    },
    flush: flushPendingOutput,
  }
}
