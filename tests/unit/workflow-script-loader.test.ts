import { describe, expect, test } from 'vitest'

import { extractMeta, loadWorkflowScriptSource } from '../../src/server/workflow-script-loader.js'

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

  test('allows numeric workflow caps in the meta literal', () => {
    const src = `export const meta = { name: 'n', description: 'd', maxAgentCalls: 5, maxDurationMs: 1000 }\n`
    const out = extractMeta(src)
    expect(out.meta.maxAgentCalls).toBe(5)
    expect(out.meta.maxDurationMs).toBe(1000)
  })

  test('caps maxDurationMs to the documented setTimeout-safe maximum', () => {
    const src = `export const meta = { name: 'n', description: 'd', maxDurationMs: 2147483648 }\n`
    const out = extractMeta(src)
    expect(out.meta.maxDurationMs).toBe(2_147_483_647)
    const scientific = extractMeta(
      `export const meta = { name: 'n', description: 'd', maxDurationMs: 1e15 }\n`
    )
    expect(scientific.meta.maxDurationMs).toBe(2_147_483_647)
  })

  test('throws when meta is missing', () => {
    expect(() => extractMeta('return 1')).toThrow(/meta/)
  })

  test('throws when meta lacks description', () => {
    expect(() => extractMeta(`export const meta = { name: 'x' }\n`)).toThrow(/description/)
  })

  test('rejects executable expressions inside the meta literal', () => {
    expect(() =>
      extractMeta(
        `export const meta = { name: 'x', description: process.cwd(), maxAgentCalls: 1 }\nreturn 1`
      )
    ).toThrow(/pure literal|process/)
  })
})

describe('loadWorkflowScriptSource', () => {
  test('transpiles the body into a callable async function source + stable hash', async () => {
    const src = `export const meta = { name: 'r', description: 'd' }\nconst x: number = await agent({ prompt: 'hi' })\nreturn x`
    const loaded = await loadWorkflowScriptSource(src, '.hive/workflows/r.ts')
    expect(loaded.meta.name).toBe('r')
    expect(loaded.scriptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.compiledFunctionSource).toContain('async function __wf')
    expect(loaded.compiledFunctionSource).not.toContain(': number')
    expect(loaded.compiledFunctionSource).toContain('return x')
  })

  test('hash is identical when only comments change', async () => {
    const a = await loadWorkflowScriptSource(
      `export const meta={name:'n',description:'d'}\nreturn 1`,
      'p'
    )
    const b = await loadWorkflowScriptSource(
      `export const meta={name:'n',description:'d'}\n// note\nreturn 1`,
      'p'
    )
    expect(a.scriptHash).toBe(b.scriptHash)
  })

  test('rejects import statements', async () => {
    await expect(
      loadWorkflowScriptSource(
        `import x from 'y'\nexport const meta={name:'n',description:'d'}\nreturn 1`,
        'p'
      )
    ).rejects.toThrow(/import/)
  })

  test('rejects dynamic import and Node globals in the workflow body', async () => {
    await expect(
      loadWorkflowScriptSource(
        `export const meta={name:'n',description:'d'}\nconst fs = await import('node:fs')\nreturn fs`,
        'p'
      )
    ).rejects.toThrow(/import/)
    await expect(
      loadWorkflowScriptSource(
        `export const meta={name:'n',description:'d'}\nreturn process.env.HOME`,
        'p'
      )
    ).rejects.toThrow(/process/)
  })

  test('rejects Function-constructor escape paths but still permits prompt text', async () => {
    await expect(
      loadWorkflowScriptSource(
        `export const meta={name:'n',description:'d'}\nreturn globalThis.constructor.constructor('return process')()`,
        'p'
      )
    ).rejects.toThrow(/globalThis|constructor|process/)

    const loaded = await loadWorkflowScriptSource(
      `export const meta={name:'n',description:'d'}\nreturn await agent('review the process lifecycle')`,
      'p'
    )
    expect(loaded.compiledFunctionSource).toContain('process lifecycle')
  })
})
