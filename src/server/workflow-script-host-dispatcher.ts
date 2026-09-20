import { planWorkflowDag } from './workflow-dag.js'

export interface WorkflowScriptHostHandlers<AgentOptions> {
  agent: (prompt: string, opts: AgentOptions) => Promise<unknown>
  assertRunActive: () => void
  cancelDagLayerAgents: (layerId: unknown, reason: unknown) => void
  catchPerItem: (value: unknown) => unknown
  log: (message: string) => void
  phase: (title: string) => void
  workflow: (scriptName: string, childArgs?: unknown) => Promise<unknown>
}

export interface WorkflowScriptHostDispatchResult {
  skipPostActiveAssert?: boolean
  value?: unknown
}

export const dispatchWorkflowScriptHostCall = async <AgentOptions>(
  name: string | undefined,
  callArgs: unknown[],
  handlers: WorkflowScriptHostHandlers<AgentOptions>
): Promise<WorkflowScriptHostDispatchResult> => {
  switch (name) {
    case 'agent': {
      const [prompt, opts] = callArgs
      return {
        value: await handlers.agent(
          typeof prompt === 'string' ? prompt : String(prompt),
          (opts ?? {}) as AgentOptions
        ),
      }
    }
    case 'phase': {
      const [title] = callArgs
      handlers.phase(typeof title === 'string' ? title : String(title ?? ''))
      return {}
    }
    case 'log': {
      const [message] = callArgs
      handlers.log(typeof message === 'string' ? message : String(message))
      return {}
    }
    case 'workflow': {
      const [scriptName, childArgs] = callArgs
      return {
        value: await handlers.workflow(
          typeof scriptName === 'string' ? scriptName : String(scriptName),
          childArgs
        ),
      }
    }
    case 'catchPerItem': {
      const [item] = callArgs
      return { value: handlers.catchPerItem(item) }
    }
    case 'cancelDagLayerAgents': {
      const [layerId, reason] = callArgs
      handlers.cancelDagLayerAgents(layerId, reason)
      return { skipPostActiveAssert: true }
    }
    case 'planDag': {
      const [nodes] = callArgs
      return { value: planWorkflowDag(nodes) }
    }
    default:
      throw new Error(`Unknown workflow host call: ${name}`)
  }
}
