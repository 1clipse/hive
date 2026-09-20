#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { HIVE_SUPERVISOR_TOKEN_HEADER } from '../server/external-goal-auth.js'
import { readPackageVersion } from '../server/package-version.js'
import { sameFilesystemPath } from '../server/path-canonicalization.js'
import { DEFAULT_HIVE_PORT } from './hive-defaults.js'
import {
  CONTROLLER_TOOL_NAMES,
  CONTROLLER_TOOLS,
  readControllerThreadId,
  requireLocalControllerRuntime,
  validateControllerArguments,
} from './hive-mcp-controller.js'

type JsonRpcId = number | string | null

interface JsonRpcRequest {
  id?: JsonRpcId
  jsonrpc?: '2.0'
  method?: string
  params?: unknown
}

interface ToolCallParams {
  _meta?: unknown
  arguments?: Record<string, unknown>
  name?: string
}

export const HIVE_MCP_TOOL_NAMES = [
  'hive.list_workspaces',
  'hive.inspect_workspace',
  'hive.start_goal',
  'hive.wait_goal',
  'hive.continue_goal',
  'hive.cancel_goal',
] as const

const jsonSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  additionalProperties: false,
  properties,
  required,
  type: 'object',
})

export const HIVE_MCP_TOOLS = [
  {
    name: 'hive.list_workspaces',
    description: 'List local Hive workspaces available for external Supervisor goals.',
    inputSchema: jsonSchema({}),
  },
  {
    name: 'hive.inspect_workspace',
    description: 'Inspect a Hive workspace, its Orchestrator status, and member roster.',
    inputSchema: jsonSchema(
      {
        workspace_id: { type: 'string' },
      },
      ['workspace_id']
    ),
  },
  {
    name: 'hive.start_goal',
    description:
      'Start an external Supervisor goal by delivering it to the workspace Orchestrator.',
    inputSchema: jsonSchema(
      {
        context: {},
        goal: { type: 'string' },
        timeout_hint_ms: { type: 'number' },
        workspace_id: { type: 'string' },
      },
      ['workspace_id', 'goal']
    ),
  },
  {
    name: 'hive.wait_goal',
    description: 'Wait for durable external goal events after a cursor, with a bounded timeout.',
    inputSchema: jsonSchema(
      {
        cursor: { minimum: 0, type: 'integer' },
        goal_id: { type: 'string' },
        timeout_ms: { minimum: 0, type: 'number' },
      },
      ['goal_id']
    ),
  },
  {
    name: 'hive.continue_goal',
    description: 'Append context to an external goal and deliver it to the Orchestrator.',
    inputSchema: jsonSchema(
      {
        context: {},
        goal_id: { type: 'string' },
        message: { type: 'string' },
      },
      ['goal_id', 'message']
    ),
  },
  {
    name: 'hive.cancel_goal',
    description:
      'Cancel an external goal and notify the Orchestrator. Does not auto-cancel member dispatches.',
    inputSchema: jsonSchema(
      {
        goal_id: { type: 'string' },
        reason: { type: 'string' },
      },
      ['goal_id', 'reason']
    ),
  },
] as const

const parseBaseUrl = (argv: string[], env: NodeJS.ProcessEnv): string => {
  const index = argv.indexOf('--base-url')
  if (index !== -1) {
    const value = argv[index + 1]
    if (!value) throw new Error('--base-url requires a value')
    return value.replace(/\/$/u, '')
  }
  if (env.HIVE_MCP_BASE_URL) return env.HIVE_MCP_BASE_URL.replace(/\/$/u, '')
  if (env.HIVE_PORT) return `http://127.0.0.1:${env.HIVE_PORT}`
  return `http://127.0.0.1:${DEFAULT_HIVE_PORT}`
}

const readHttpErrorDetail = async (response: Response) => {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    return text.trim()
  }
  return text.trim()
}

const getSupervisorToken = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/external-goals/session`)
  if (!response.ok) throw new Error(await readHttpErrorDetail(response))
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('Hive runtime did not issue a Supervisor token')
  }
  return body.token
}

const requestJson = async (baseUrl: string, path: string, init: RequestInit = {}) => {
  const supervisorToken = await getSupervisorToken(baseUrl)
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      [HIVE_SUPERVISOR_TOKEN_HEADER]: supervisorToken,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!response.ok) throw new Error(await readHttpErrorDetail(response))
  return response.json() as Promise<unknown>
}

const postJson = (baseUrl: string, path: string, body: unknown) =>
  requestJson(baseUrl, path, {
    body: JSON.stringify(body),
    method: 'POST',
  })

const requireStringArg = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

export const callHiveMcpTool = async (
  toolName: string,
  args: Record<string, unknown> = {},
  input: { baseUrl?: string; env?: NodeJS.ProcessEnv; metadata?: unknown } = {}
) => {
  const baseUrl = input.baseUrl ?? parseBaseUrl([], input.env ?? process.env)
  if ((CONTROLLER_TOOL_NAMES as readonly string[]).includes(toolName)) {
    requireLocalControllerRuntime(baseUrl)
    const threadId = readControllerThreadId(input.metadata)
    validateControllerArguments(toolName, args)
    return requestJson(
      baseUrl,
      toolName === 'hive.controller_connect' ? '/api/controller/request' : '/api/controller/action',
      {
        method: 'POST',
        headers: { 'x-hive-controller-thread-id': threadId },
        body: JSON.stringify(args),
      }
    )
  }
  if (toolName === 'hive.list_workspaces') {
    return requestJson(baseUrl, '/api/external-goals/workspaces')
  }
  if (toolName === 'hive.inspect_workspace') {
    const workspaceId = requireStringArg(args, 'workspace_id')
    return requestJson(baseUrl, `/api/external-goals/workspaces/${encodeURIComponent(workspaceId)}`)
  }
  if (toolName === 'hive.start_goal') {
    return postJson(baseUrl, '/api/external-goals/start', {
      context: args.context,
      goal: requireStringArg(args, 'goal'),
      source: 'hive-mcp',
      timeout_hint_ms: args.timeout_hint_ms,
      workspace_id: requireStringArg(args, 'workspace_id'),
    })
  }
  if (toolName === 'hive.wait_goal') {
    return postJson(baseUrl, '/api/external-goals/wait', {
      cursor: args.cursor,
      goal_id: requireStringArg(args, 'goal_id'),
      timeout_ms: args.timeout_ms,
    })
  }
  if (toolName === 'hive.continue_goal') {
    return postJson(baseUrl, '/api/external-goals/continue', {
      context: args.context,
      goal_id: requireStringArg(args, 'goal_id'),
      message: requireStringArg(args, 'message'),
    })
  }
  if (toolName === 'hive.cancel_goal') {
    return postJson(baseUrl, '/api/external-goals/cancel', {
      goal_id: requireStringArg(args, 'goal_id'),
      reason: requireStringArg(args, 'reason'),
    })
  }
  throw new Error(`Unknown Hive MCP tool: ${toolName}`)
}

const resultResponse = (id: JsonRpcId | undefined, result: unknown) => ({
  id,
  jsonrpc: '2.0',
  result,
})

const errorResponse = (id: JsonRpcId | undefined, code: number, message: string) => ({
  error: { code, message },
  id: id ?? null,
  jsonrpc: '2.0',
})

const toolResult = (result: unknown) => ({
  content: [
    {
      text: JSON.stringify(result),
      type: 'text',
    },
  ],
  structuredContent: result,
})

const handleRequest = async (request: JsonRpcRequest, baseUrl: string, controllerMode: boolean) => {
  if (!request.method) {
    return errorResponse(request.id, -32600, 'Invalid JSON-RPC request')
  }
  if (request.method === 'initialize') {
    return resultResponse(request.id, {
      capabilities: { tools: {} },
      protocolVersion:
        typeof (request.params as { protocolVersion?: unknown } | null)?.protocolVersion ===
        'string'
          ? (request.params as { protocolVersion: string }).protocolVersion
          : '2025-06-18',
      serverInfo: { name: 'hive-supervisor', version: readPackageVersion() },
    })
  }
  if (request.method === 'ping') return resultResponse(request.id, {})
  if (request.method === 'tools/list') {
    const tools = controllerMode ? [HIVE_MCP_TOOLS[0], ...CONTROLLER_TOOLS] : HIVE_MCP_TOOLS
    return resultResponse(request.id, { tools })
  }
  if (request.method === 'tools/call') {
    const params = request.params as ToolCallParams
    if (!params?.name) return errorResponse(request.id, -32602, 'Missing tool name')
    const allowed = controllerMode
      ? ['hive.list_workspaces', ...CONTROLLER_TOOL_NAMES]
      : HIVE_MCP_TOOL_NAMES
    if (!(allowed as readonly string[]).includes(params.name)) {
      return errorResponse(request.id, -32602, 'Tool is not available in this Hive MCP mode')
    }
    const result = await callHiveMcpTool(params.name, params.arguments ?? {}, {
      baseUrl,
      metadata: params._meta,
    })
    return resultResponse(request.id, toolResult(result))
  }
  if (request.id === undefined) return null
  return errorResponse(request.id, -32601, `Unknown method: ${request.method}`)
}

const writeJsonRpc = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

export const runHiveMcpCommand = async (
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> => {
  const baseUrl = parseBaseUrl(argv, env)
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let requestId: JsonRpcId | undefined
    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest
      requestId = request.id
      const response = await handleRequest(request, baseUrl, argv.includes('--controller'))
      if (response) writeJsonRpc(response)
    } catch (error) {
      writeJsonRpc(
        errorResponse(requestId, -32603, error instanceof Error ? error.message : String(error))
      )
    }
  }
}

const isMainModule = process.argv[1]
  ? sameFilesystemPath(fileURLToPath(import.meta.url), process.argv[1])
  : false

if (isMainModule) {
  void runHiveMcpCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
