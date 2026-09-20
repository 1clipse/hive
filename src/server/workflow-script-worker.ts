import { Worker } from 'node:worker_threads'

import {
  dispatchWorkflowScriptHostCall,
  type WorkflowScriptHostHandlers,
} from './workflow-script-host-dispatcher.js'

export type WorkflowScriptWorker = Worker
export type WorkflowScriptWorkerSource = string | URL

export interface RunWorkflowScriptWorkerInput<AgentOptions> {
  args: unknown
  compiledFunctionSource: string
  handlers: WorkflowScriptHostHandlers<AgentOptions>
  onHostCallStarted?: (call: Promise<void>) => void
  onWorkerCreated?: (worker: WorkflowScriptWorker) => void
  onWorkerSettled?: (worker: WorkflowScriptWorker) => void
  scriptPath: string
  workerSource: WorkflowScriptWorkerSource
}

const errorToMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const runWorkflowScriptWorker = <AgentOptions>({
  args,
  compiledFunctionSource,
  handlers,
  onHostCallStarted,
  onWorkerCreated,
  onWorkerSettled,
  scriptPath,
  workerSource,
}: RunWorkflowScriptWorkerInput<AgentOptions>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      ...(typeof workerSource === 'string' ? { eval: true } : {}),
      workerData: {
        args,
        compiledFunctionSource,
        scriptPath,
      },
    })
    onWorkerCreated?.(worker)

    let settled = false
    const activeHostCalls = new Set<Promise<void>>()
    const settle = (fn: () => void, input: { waitForHostCalls: boolean }) => {
      if (settled) return
      settled = true
      onWorkerSettled?.(worker)
      void (async () => {
        if (input.waitForHostCalls) {
          await Promise.allSettled(activeHostCalls)
        }
        fn()
        void worker.terminate().catch(() => {})
      })()
    }
    const respond = (id: string, response: { error?: string; ok: boolean; value?: unknown }) => {
      try {
        worker.postMessage({ type: 'hostResponse', id, ...response })
      } catch {
        /* worker already terminated */
      }
    }
    worker.on('message', (message: unknown) => {
      const record = message as {
        args?: unknown
        error?: string
        id?: string
        name?: string
        ok?: boolean
        type?: string
        value?: unknown
      } | null
      if (!record) return
      if (record.type === 'done') {
        settle(
          () => {
            if (record.ok) resolve(record.value)
            else reject(new Error(record.error || 'Hive workflow script failed'))
          },
          { waitForHostCalls: record.ok === true }
        )
        return
      }
      if (record.type !== 'hostCall' || typeof record.id !== 'string') return
      const callId = record.id
      if (settled) {
        respond(callId, { ok: false, error: 'Stopped by user' })
        return
      }
      const hostCall = (async () => {
        try {
          handlers.assertRunActive()
          const callArgs = Array.isArray(record.args) ? record.args : []
          const result = await dispatchWorkflowScriptHostCall(record.name, callArgs, handlers)
          if (!result.skipPostActiveAssert) handlers.assertRunActive()
          respond(callId, { ok: true, value: result.value })
        } catch (error) {
          respond(callId, { ok: false, error: errorToMessage(error) })
        }
      })()
      activeHostCalls.add(hostCall)
      onHostCallStarted?.(hostCall)
      void hostCall.finally(() => activeHostCalls.delete(hostCall))
    })
    worker.on('error', (error) => settle(() => reject(error), { waitForHostCalls: false }))
    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      onWorkerSettled?.(worker)
      reject(new Error(`Hive workflow VM worker exited before completion (code ${code})`))
    })
  })
