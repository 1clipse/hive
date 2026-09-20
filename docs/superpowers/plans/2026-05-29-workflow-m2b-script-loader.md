# M2 Slice B — Workflow Script Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Turn a `.hive/workflows/<name>.ts` file into a runnable: extract its `meta` (pure literal, validated), transpile the body to a callable async function (esbuild), and compute a stable `script_hash`.

**Architecture (verified against esbuild 0.28.0):** esbuild rejects top-level `return`/`await` as ESM, so the loader (1) statically extracts the `export const meta = {…}` literal via brace-matching and `eval`s it in isolation, (2) strips that statement, (3) **wraps the remaining body in `async function __wf(agent, parallel, pipeline, phase, log, workflow, args) { … }`** so top-level `await`/`return` become valid, (4) `esbuild.transform(loader:'ts')` that wrapper to JS, (5) `script_hash = sha256(transpiledJs)`. The runner (M2-C) evaluates the JS via `new Function(js + '; return __wf')()` and calls it with the DSL + args.

**Tech Stack:** esbuild 0.28.0 (added to `dependencies`), node:crypto, TypeScript, Vitest, Biome.

**Spec references:** §3 (DSL/meta), §4 (transpile + script_hash). Imports are rejected (scripts use ambient DSL + inline schemas).

## File structure

- Create: `src/server/workflow-script-loader.ts` — `loadWorkflowScriptSource(source, scriptPath)` (pure, sync-ish over a string) + `loadWorkflowScriptFile(absPath)` (reads file).
- Test: `tests/unit/workflow-script-loader.test.ts`.

## Types

```ts
export interface WorkflowMeta {
  name: string
  description: string
  cron?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}
export interface LoadedWorkflow {
  meta: WorkflowMeta
  scriptPath: string
  scriptHash: string
  compiledFunctionSource: string // transpiled `async function __wf(...) {…}`
}
```

---

## Task 1: meta extraction (brace-matching) + validation

**Files:** `src/server/workflow-script-loader.ts`; Test: `tests/unit/workflow-script-loader.test.ts`

- [ ] **Step 1: failing tests** (extraction edge cases)

```ts
import { describe, expect, test } from 'vitest'
import { extractMeta } from '../../src/server/workflow-script-loader.js'

describe('extractMeta', () => {
  test('extracts a simple meta literal and returns the body without it', () => {
    const src = `export const meta = { name: 'r', description: 'd' }\nreturn await agent({})`
    const out = extractMeta(src)
    expect(out.meta).toEqual({ name: 'r', description: 'd' })
    expect(out.body).not.toContain('meta')
    expect(out.body).toContain('return await agent')
  })

  test('handles braces inside strings and an `as const` suffix', () => {
    const src = `export const meta = { name: 'a}b', description: "c{d}" } as const\nlog('x')`
    const out = extractMeta(src)
    expect(out.meta.name).toBe('a}b')
    expect(out.meta.description).toBe('c{d}')
    expect(out.body.trim()).toBe("log('x')")
  })

  test('handles nested objects/arrays (phases)', () => {
    const src = `export const meta = { name: 'n', description: 'd', phases: [{ title: 'Find' }] }\n`
    const out = extractMeta(src)
    expect(out.meta.phases).toEqual([{ title: 'Find' }])
  })

  test('throws when meta is missing', () => {
    expect(() => extractMeta(`return 1`)).toThrow(/meta/)
  })

  test('throws when meta lacks name or description', () => {
    expect(() => extractMeta(`export const meta = { name: 'x' }\n`)).toThrow(/description/)
  })
})
```

- [ ] **Step 2: run → FAIL** (`extractMeta` not exported).

- [ ] **Step 3: implement `extractMeta`** (in `workflow-script-loader.ts`)

```ts
interface ExtractedMeta {
  meta: WorkflowMeta
  body: string
}

// Find the matching close brace for the object literal starting at openIndex
// (which must point at '{'), respecting '...' "..." `...` strings and // /* */
// comments so braces inside them don't miscount.
const matchBrace = (source: string, openIndex: number): number => {
  let depth = 0
  let i = openIndex
  let str: string | null = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (str) {
      if (ch === '\\') { i += 2; continue }
      if (ch === str) str = null
      i += 1
      continue
    }
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i === -1) i = source.length; continue }
    if (ch === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; continue }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; i += 1; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  throw new Error('workflow meta: unbalanced braces in `export const meta`')
}

export const extractMeta = (source: string): ExtractedMeta => {
  const re = /export\s+const\s+meta\s*(?::[^=]+)?=\s*\{/
  const m = re.exec(source)
  if (!m) throw new Error('workflow script must `export const meta = { name, description }`')
  const braceStart = source.indexOf('{', m.index + m[0].length - 1)
  const braceEnd = matchBrace(source, braceStart)
  const literal = source.slice(braceStart, braceEnd + 1)
  let meta: WorkflowMeta
  try {
    // meta MUST be a pure literal (no calls/vars); eval in isolation.
    meta = new Function(`return (${literal})`)() as WorkflowMeta
  } catch (error) {
    throw new Error(`workflow meta is not a plain literal: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
    throw new Error('workflow meta requires a non-empty `name`')
  }
  if (typeof meta.description !== 'string') {
    throw new Error('workflow meta requires a `description`')
  }
  // Strip from `export const meta` through the close brace + optional `as const`/`;`.
  let after = braceEnd + 1
  const tail = source.slice(after)
  const tailMatch = /^(\s*as\s+const)?\s*;?/.exec(tail)
  if (tailMatch) after += tailMatch[0].length
  const body = source.slice(0, m.index) + source.slice(after)
  return { meta, body }
}
```

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: commit** — `git commit -m "Add workflow meta extraction (brace-matched, validated)"`

---

## Task 2: transpile + hash + file loader

**Files:** `src/server/workflow-script-loader.ts`; Test: same file

- [ ] **Step 1: failing tests**

```ts
import { loadWorkflowScriptSource } from '../../src/server/workflow-script-loader.js'

describe('loadWorkflowScriptSource', () => {
  test('transpiles the body into a callable async function source + stable hash', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }\nconst x: number = await agent({ prompt: 'hi' })\nreturn x`
    const loaded = await loadWorkflowScriptSource(src, '.hive/workflows/r.ts')
    expect(loaded.meta.name).toBe('r')
    expect(loaded.scriptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.compiledFunctionSource).toContain('async function __wf')
    expect(loaded.compiledFunctionSource).not.toContain(': number') // types stripped
    // The transpiled source is evaluable into an AsyncFunction.
    const fn = new Function(`${loaded.compiledFunctionSource}; return __wf`)()
    expect(fn.constructor.name).toBe('AsyncFunction')
  })

  test('hash is identical when only comments change (esbuild strips comments)', async () => {
    const a = await loadWorkflowScriptSource(`export const meta={name:'n',description:'d'}\nreturn 1`, 'p')
    const b = await loadWorkflowScriptSource(`export const meta={name:'n',description:'d'}\n// note\nreturn 1`, 'p')
    expect(a.scriptHash).toBe(b.scriptHash)
  })

  test('rejects import statements', async () => {
    await expect(
      loadWorkflowScriptSource(`import x from 'y'\nexport const meta={name:'n',description:'d'}\nreturn 1`, 'p')
    ).rejects.toThrow(/import/)
  })
})
```

- [ ] **Step 2: run → FAIL.**

- [ ] **Step 3: implement**

```ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { transform } from 'esbuild'

const DSL_PARAMS = 'agent, parallel, pipeline, phase, log, workflow, args'

export const loadWorkflowScriptSource = async (
  source: string,
  scriptPath: string
): Promise<LoadedWorkflow> => {
  if (/^\s*import\s/m.test(source)) {
    throw new Error('workflow scripts may not use `import`; use the ambient DSL + inline schemas')
  }
  const { meta, body } = extractMeta(source)
  const wrapped = `async function __wf(${DSL_PARAMS}) {\n${body}\n}`
  const { code } = await transform(wrapped, { loader: 'ts', target: 'es2022' })
  const scriptHash = createHash('sha256').update(code).digest('hex')
  return { meta, scriptPath, scriptHash, compiledFunctionSource: code }
}

export const loadWorkflowScriptFile = async (absPath: string): Promise<LoadedWorkflow> =>
  loadWorkflowScriptSource(await readFile(absPath, 'utf8'), absPath)
```

(Place the `WorkflowMeta`/`LoadedWorkflow` interfaces + `extractMeta` above; export all.)

- [ ] **Step 4: run → PASS.**

- [ ] **Step 5: commit** — `git commit -m "Transpile workflow bodies to a callable async function with a stable hash"`

---

## Task 3: gate + push

- [ ] `pnpm check && pnpm test` — biome clean + green. (esbuild is now a runtime dep; the package-tarball integration test, if it asserts dependency shape, may need updating — treat as real.)
- [ ] `git push private feat/workflow-runtime`.

## Self-review

- **Spec coverage:** §4 transpile + §4 script_hash → Task 2; meta literal extraction/validation → Task 1; import rejection → Task 2.
- **Mechanism verified:** wrap-in-async-function + `new Function(code + '; return __wf')()` confirmed against esbuild 0.28.0 (top-level await/return valid inside the wrapper).
- **Hash semantics:** sha256 of the transpiled (comment-stripped) JS → comment-only edits don't invalidate (spec gap #2).
- **Safety:** `meta` eval'd in isolation via `new Function` (pure literal per spec); body is NOT executed at load time (only transpiled), so no side effects until the runner invokes it.

## Downstream

- **M2-C:** the DSL host functions (`agent/parallel/pipeline/phase/log/workflow`) + the runner that evaluates `compiledFunctionSource`, drives `workflow_runs`, and implements `agent()` = spawn → dispatch → await report → schema-validate (dispatch-await via a `workflow:dispatch_observed` in-process event).
- **M2-D:** `routes-workflows` (list scripts, start/stop/list runs).
