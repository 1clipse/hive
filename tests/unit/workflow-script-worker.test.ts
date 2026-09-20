import { describe, expect, test, vi } from 'vitest'

import type { WorkflowScriptHostHandlers } from '../../src/server/workflow-script-host-dispatcher.js'
import { runWorkflowScriptWorker } from '../../src/server/workflow-script-worker.js'
import { WORKFLOW_VM_WORKER_URL } from '../../src/server/workflow-vm-worker-source.js'

const createHandlers = (
  overrides: Partial<WorkflowScriptHostHandlers<Record<string, unknown>>> = {}
): WorkflowScriptHostHandlers<Record<string, unknown>> => ({
  agent: async () => null,
  assertRunActive: vi.fn(),
  cancelDagLayerAgents: vi.fn(),
  catchPerItem: (value) => value,
  log: vi.fn(),
  phase: vi.fn(),
  workflow: async () => null,
  ...overrides,
})

describe('runWorkflowScriptWorker', () => {
  test('rejects unknown host calls from the worker source', async () => {
    await expect(
      runWorkflowScriptWorker({
        args: undefined,
        compiledFunctionSource: '',
        handlers: createHandlers(),
        scriptPath: '<test>',
        workerSource: `
          const { parentPort } = require('node:worker_threads');
          parentPort.on('message', (message) => {
            if (message.type !== 'hostResponse') return;
            parentPort.postMessage({
              type: 'done',
              ok: message.ok,
              value: message.value,
              error: message.error,
            });
          });
          parentPort.postMessage({ type: 'hostCall', id: '1', name: 'missingHostCall', args: [] });
        `,
      })
    ).rejects.toThrow()
  })

  test('rejects when the worker exits before completion', async () => {
    await expect(
      runWorkflowScriptWorker({
        args: undefined,
        compiledFunctionSource: '',
        handlers: createHandlers(),
        scriptPath: '<test>',
        workerSource: 'process.exit(7);',
      })
    ).rejects.toThrow(/code 7/)
  })

  test('waits for active host calls before resolving a done message', async () => {
    let hostCallFinished = false
    const result = await runWorkflowScriptWorker({
      args: undefined,
      compiledFunctionSource: '',
      handlers: createHandlers({
        agent: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25))
          hostCallFinished = true
          return 'agent-result'
        },
      }),
      scriptPath: '<test>',
      workerSource: `
        const { parentPort } = require('node:worker_threads');
        parentPort.postMessage({ type: 'hostCall', id: '1', name: 'agent', args: ['prompt', {}] });
        parentPort.postMessage({ type: 'done', ok: true, value: 'done' });
      `,
    })

    expect(result).toBe('done')
    expect(hostCallFinished).toBe(true)
  })

  test('rejects failed done messages before waiting for active host calls', async () => {
    let releaseHostCall!: () => void
    let hostCallFinished = false
    const pendingHostCall = new Promise<void>((resolve) => {
      releaseHostCall = () => {
        hostCallFinished = true
        resolve()
      }
    })

    await expect(
      runWorkflowScriptWorker({
        args: undefined,
        compiledFunctionSource: '',
        handlers: createHandlers({
          agent: async () => {
            await pendingHostCall
            return 'late'
          },
        }),
        scriptPath: '<test>',
        workerSource: `
          const { parentPort } = require('node:worker_threads');
          parentPort.postMessage({ type: 'hostCall', id: '1', name: 'agent', args: ['prompt', {}] });
          parentPort.postMessage({ type: 'done', ok: false, error: 'boom' });
        `,
      })
    ).rejects.toThrow(/boom/)
    expect(hostCallFinished).toBe(false)
    releaseHostCall()
    await pendingHostCall
    expect(hostCallFinished).toBe(true)
  })

  test('runs the production VM source with isolated concurrent DAG layer contexts', async () => {
    const calls: Array<{ layerId: string | null; prompt: string }> = []
    const result = await runWorkflowScriptWorker({
      args: undefined,
      compiledFunctionSource: `
        async function __wf(dsl) {
          const { agent, dag } = dsl
          const first = dag([
            { id: 'a', run: async () => {
              await Promise.resolve()
              return await agent('a')
            } },
          ])
          const second = dag([
            { id: 'b', run: () => agent('b') },
          ])
          return await Promise.all([first, second])
        }
      `,
      handlers: createHandlers({
        agent: async (prompt, opts) => {
          const layerId = typeof opts.__hiveDagLayerId === 'string' ? opts.__hiveDagLayerId : null
          calls.push({ layerId, prompt })
          if (prompt === 'b') await new Promise((resolve) => setTimeout(resolve, 25))
          return `${prompt}:${layerId}`
        },
      }),
      scriptPath: '<test>',
      workerSource: WORKFLOW_VM_WORKER_URL,
    })

    expect(calls).toContainEqual({ prompt: 'a', layerId: 'dag-layer-1' })
    expect(calls).toContainEqual({ prompt: 'b', layerId: 'dag-layer-2' })
    expect(result).toEqual([
      { order: ['a'], results: { a: 'a:dag-layer-1' } },
      { order: ['b'], results: { b: 'b:dag-layer-2' } },
    ])
  })

  test('routes production VM DAG failures through cancelDagLayerAgents', async () => {
    const cancelDagLayerAgents = vi.fn()

    await expect(
      runWorkflowScriptWorker({
        args: undefined,
        compiledFunctionSource: `
          async function __wf(dsl) {
            const { agent, dag } = dsl
            return await dag([
              { id: 'slow', run: () => agent('slow') },
              { id: 'boom', run: async () => {
                await agent('boom')
                throw new Error('boom')
              } },
            ])
          }
        `,
        handlers: createHandlers({
          agent: async (prompt) => {
            if (prompt === 'slow') await new Promise((resolve) => setTimeout(resolve, 25))
            return prompt
          },
          cancelDagLayerAgents,
        }),
        scriptPath: '<test>',
        workerSource: WORKFLOW_VM_WORKER_URL,
      })
    ).rejects.toThrow(/boom/)

    expect(cancelDagLayerAgents).toHaveBeenCalledWith(
      'dag-layer-1',
      expect.stringMatching(/DAG node failed: .*boom/)
    )
  })
})
