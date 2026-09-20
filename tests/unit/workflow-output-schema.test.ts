import { describe, expect, test } from 'vitest'

import {
  buildSchemaInstruction,
  extractJsonBlock,
} from '../../src/server/workflow-output-schema.js'

describe('extractJsonBlock', () => {
  test('parses the object from a report ending in a fenced json block', () => {
    const text = 'I checked it.\n\n```json\n{"refuted": false}\n```'
    // Assert the actual boolean, not just truthiness — a reversed helper that
    // returned {} or {refuted:true} would pass a truthiness check but fail here.
    expect(extractJsonBlock(text)).toEqual({ refuted: false })
  })

  test('returns null when there is no fenced block (so the runner falls back to {text})', () => {
    expect(extractJsonBlock('Just prose, no block at all.')).toBeNull()
  })

  test('returns null on a fenced block with invalid JSON rather than throwing', () => {
    const text = '```json\n{ refuted: false, }\n```'
    expect(extractJsonBlock(text)).toBeNull()
  })

  test('picks the LAST fenced block when there are several', () => {
    const text = '```json\n{"refuted": true}\n```\nfinal answer:\n```json\n{"refuted": false}\n```'
    expect(extractJsonBlock(text)).toEqual({ refuted: false })
  })

  test('returns null for a block that parses to a non-object (bare number)', () => {
    expect(extractJsonBlock('```json\n42\n```')).toBeNull()
  })

  test('returns null for a block that parses to an array', () => {
    expect(extractJsonBlock('```json\n[1, 2, 3]\n```')).toBeNull()
  })

  test('accepts a bare (non-"json"-tagged) fence', () => {
    expect(extractJsonBlock('```\n{"ok": true}\n```')).toEqual({ ok: true })
  })
})

describe('buildSchemaInstruction', () => {
  test('names every schema key', () => {
    const out = buildSchemaInstruction({ refuted: 'boolean', severity: 'string' })
    expect(out).toContain('refuted')
    expect(out).toContain('severity')
  })

  test('tells the worker to emit a fenced json block', () => {
    const out = buildSchemaInstruction({ refuted: 'boolean' })
    expect(out).toContain('json')
    expect(out).toContain('```')
  })
})
