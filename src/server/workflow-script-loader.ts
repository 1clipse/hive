import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { BadRequestError } from './http-errors.js'

export interface WorkflowMeta {
  name: string
  description: string
  cron?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /** TIER 2 #11 — per-script budget overrides. Hard cap on total
   *  `agent()` calls (default 1000 — matches CC's lifetime cap) and on
   *  wall-clock duration in ms (default 60 min). Both apply to the
   *  ENTIRE run including nested workflow() calls; exceeding either
   *  rejects the offending agent() call and the run transitions to
   *  'failed' (or 'stopped' if duration was the trigger).
   *  `maxDurationMs` is capped at `MAX_WORKFLOW_DURATION_MS` (`2^31-1`)
   *  because Node `setTimeout` clamps larger delays to 1ms. */
  maxAgentCalls?: number
  maxDurationMs?: number
}

/** Node `setTimeout` only accepts a signed 32-bit delay; larger values
 *  become 1ms. This is the documented maximum for `meta.maxDurationMs`. */
export const MAX_WORKFLOW_DURATION_MS = 2 ** 31 - 1

export interface LoadedWorkflow {
  meta: WorkflowMeta
  scriptPath: string
  scriptHash: string
  /** Transpiled `async function __wf(dsl) {…}` — the runner executes it in a
   *  locked-down VM context and calls it with the Hive DSL bridge object. */
  compiledFunctionSource: string
}

interface ExtractedMeta {
  meta: WorkflowMeta
  body: string
}

const DSL_BINDINGS = 'agent, parallel, pipeline, phase, log, workflow, dag, args'

interface CodeToken {
  index: number
  type: 'identifier' | 'number' | 'punct'
  value: string
}

const DANGEROUS_WORKFLOW_IDENTIFIERS = new Set([
  'AsyncFunction',
  'Bun',
  'Buffer',
  'Deno',
  'Function',
  'Proxy',
  'Reflect',
  'WebAssembly',
  'XMLHttpRequest',
  '__proto__',
  'constructor',
  'document',
  'eval',
  'exports',
  'fetch',
  'global',
  'globalThis',
  'import',
  'module',
  'process',
  'prototype',
  'queueMicrotask',
  'require',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'this',
  'window',
])

const META_LITERAL_KEYWORDS = new Set(['false', 'null', 'true'])

const isIdentStart = (ch: string) => /[$A-Z_a-z]/.test(ch)
const isIdentPart = (ch: string) => /[$0-9A-Z_a-z]/.test(ch)

const scanCodeTokens = (source: string): CodeToken[] => {
  const tokens: CodeToken[] = []
  const modes: Array<{ braceDepth: number; kind: 'code' | 'template' }> = [
    { kind: 'code', braceDepth: -1 },
  ]
  let i = 0
  while (i < source.length) {
    const mode = modes[modes.length - 1]
    if (!mode) break
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)

    if (mode.kind === 'template') {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '`') {
        modes.pop()
        i += 1
        continue
      }
      if (ch === '$' && next === '{') {
        modes.push({ kind: 'code', braceDepth: 0 })
        i += 2
        continue
      }
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i + 2)
      i = nl === -1 ? source.length : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < source.length) {
        if (source.charAt(i) === '\\') {
          i += 2
          continue
        }
        if (source.charAt(i) === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '`') {
      modes.push({ kind: 'template', braceDepth: -1 })
      i += 1
      continue
    }
    if (mode.braceDepth >= 0 && ch === '}') {
      if (mode.braceDepth === 0) {
        modes.pop()
      } else {
        mode.braceDepth -= 1
        tokens.push({ index: i, type: 'punct', value: ch })
      }
      i += 1
      continue
    }
    if (ch === '{') {
      if (mode.braceDepth >= 0) mode.braceDepth += 1
      tokens.push({ index: i, type: 'punct', value: ch })
      i += 1
      continue
    }
    if (/[0-9]/.test(ch)) {
      const match = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i))
      if (match) {
        tokens.push({ index: i, type: 'number', value: match[0] })
        i += match[0].length
        continue
      }
    }
    if (isIdentStart(ch)) {
      const start = i
      i += 1
      while (i < source.length && isIdentPart(source.charAt(i))) i += 1
      tokens.push({ index: start, type: 'identifier', value: source.slice(start, i) })
      continue
    }
    if (!/\s/.test(ch)) tokens.push({ index: i, type: 'punct', value: ch })
    i += 1
  }
  return tokens
}

export const assertWorkflowScriptIsSandboxable = (source: string): void => {
  for (const token of scanCodeTokens(source)) {
    if (token.type === 'identifier' && DANGEROUS_WORKFLOW_IDENTIFIERS.has(token.value)) {
      throw new BadRequestError(
        `workflow scripts may not use \`${token.value}\`; use the Hive DSL and put file, shell, network, or validation work inside agent() prompts`
      )
    }
  }
}

const assertPlainMetaLiteral = (literal: string): void => {
  const tokens = scanCodeTokens(literal)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    if (token.type === 'identifier') {
      const nextToken = tokens[i + 1]
      const isObjectKey = nextToken?.type === 'punct' && nextToken.value === ':'
      if (!isObjectKey && !META_LITERAL_KEYWORDS.has(token.value)) {
        throw new BadRequestError(
          `workflow meta must be a pure literal; unexpected identifier \`${token.value}\``
        )
      }
    } else if (token.type === 'punct' && !['{', '}', '[', ']', ':', ','].includes(token.value)) {
      throw new BadRequestError(
        `workflow meta must be a pure literal; unexpected token \`${token.value}\``
      )
    }
  }
}

// Find the matching close brace for the object literal whose '{' is at
// openIndex, ignoring braces inside '...' "..." `...` strings and // /* */
// comments so they don't miscount the depth.
const matchBrace = (source: string, openIndex: number): number => {
  let depth = 0
  let i = openIndex
  let str: string | null = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (str) {
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === str) str = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  throw new BadRequestError('workflow meta: unbalanced braces in `export const meta`')
}

export const extractMeta = (source: string): ExtractedMeta => {
  const re = /export\s+const\s+meta\s*(?::[^=]+)?=\s*\{/
  const m = re.exec(source)
  if (!m) {
    throw new BadRequestError('workflow script must `export const meta = { name, description }`')
  }
  const braceStart = source.indexOf('{', m.index + m[0].length - 1)
  const braceEnd = matchBrace(source, braceStart)
  const literal = source.slice(braceStart, braceEnd + 1)
  assertPlainMetaLiteral(literal)
  let meta: WorkflowMeta
  try {
    // meta MUST be a pure literal (no calls/vars); eval it in isolation.
    meta = new Function(`return (${literal})`)() as WorkflowMeta
  } catch (error) {
    throw new BadRequestError(
      `workflow meta is not a plain literal: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new BadRequestError('workflow meta requires a non-empty `name`')
  }
  if (typeof meta.description !== 'string') {
    throw new BadRequestError('workflow meta requires a `description`')
  }
  if (meta.maxDurationMs !== undefined) {
    if (typeof meta.maxDurationMs !== 'number' || !Number.isFinite(meta.maxDurationMs)) {
      throw new BadRequestError('workflow meta.maxDurationMs must be a finite number')
    }
    if (meta.maxDurationMs > MAX_WORKFLOW_DURATION_MS) {
      meta.maxDurationMs = MAX_WORKFLOW_DURATION_MS
    }
  }
  let after = braceEnd + 1
  const tailMatch = /^(\s*as\s+const)?\s*;?/.exec(source.slice(after))
  if (tailMatch) after += tailMatch[0].length
  const body = source.slice(0, m.index) + source.slice(after)
  return { meta, body }
}

// Module-level cache for esbuild's dynamic import. esbuild's top-level
// invariant check requires `new TextEncoder().encode('') instanceof
// Uint8Array` — true in Node, FALSE in jsdom's realm. Workflow runs are not
// designed to be exercised end-to-end inside a jsdom test environment;
// jsdom-hosted tests stub the run step at the network layer.
let esbuildModulePromise: Promise<typeof import('esbuild')> | null = null

const loadEsbuild = async (): Promise<typeof import('esbuild')> => {
  if (!esbuildModulePromise) esbuildModulePromise = import('esbuild')
  return esbuildModulePromise
}

export const loadWorkflowScriptSource = async (
  source: string,
  scriptPath: string
): Promise<LoadedWorkflow> => {
  if (/^\s*import\s/m.test(source)) {
    throw new BadRequestError(
      'workflow scripts may not use `import`; use the ambient DSL + inline schemas'
    )
  }
  const { meta, body } = extractMeta(source)
  assertWorkflowScriptIsSandboxable(body)
  const wrapped = `async function __wf(dsl) {\nconst { ${DSL_BINDINGS} } = dsl\n${body}\n}`
  // Lazy-load esbuild: its native binary breaks under jsdom/worker contexts
  // used by the web test suite, so importing it at module-load time would
  // crash any test file that transitively pulls in the runtime store. The
  // transpile path is only reached when a workflow actually runs.
  const { transform } = await loadEsbuild()
  const { code } = await transform(wrapped, { loader: 'ts', target: 'es2022' })
  const scriptHash = createHash('sha256').update(code).digest('hex')
  return { meta, scriptPath, scriptHash, compiledFunctionSource: code }
}

export const loadWorkflowScriptFile = async (absPath: string): Promise<LoadedWorkflow> =>
  loadWorkflowScriptSource(await readFile(absPath, 'utf8'), absPath)
