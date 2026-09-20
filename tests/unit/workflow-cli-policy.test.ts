import { describe, expect, test } from 'vitest'

import {
  assertValidWorkflowCliPolicy,
  CANONICAL_WORKFLOW_CLIS,
  DEFAULT_WORKFLOW_CLI_POLICY,
  normalizeWorkflowCliPolicy,
  readWorkflowCliPolicy,
  resolveWorkflowCli,
  type WorkflowCliPolicy,
} from '../../src/server/workflow-cli-policy.js'

const policy = (overrides: Partial<WorkflowCliPolicy> = {}): WorkflowCliPolicy => ({
  default: 'codex',
  allowed: ['claude', 'codex'],
  ...overrides,
})

describe('resolveWorkflowCli', () => {
  test('omitted cli + built-in role falls back to the policy default (NOT hardcoded claude)', () => {
    expect(
      resolveWorkflowCli({ isCustomTemplate: false, policy: policy({ default: 'codex' }) })
    ).toBe('codex')
  })

  test('omitted cli + custom template uses the template default and is exempt from the allowlist', () => {
    // gemini is NOT in the allowlist, but a user-curated custom role that
    // defaults to gemini is trusted — the allowlist governs the default
    // fallback + explicit opts.cli, not a deliberately configured template.
    expect(
      resolveWorkflowCli({
        isCustomTemplate: true,
        templateDefaultCommand: 'gemini',
        policy: policy(),
      })
    ).toBe('gemini')
  })

  test('explicit allowed cli is honoured', () => {
    expect(
      resolveWorkflowCli({ requestedCli: 'claude', isCustomTemplate: false, policy: policy() })
    ).toBe('claude')
  })

  test('explicit disallowed cli throws, naming the cli and the allowed set', () => {
    expect(() =>
      resolveWorkflowCli({ requestedCli: 'gemini', isCustomTemplate: false, policy: policy() })
    ).toThrow(/gemini/)
    expect(() =>
      resolveWorkflowCli({ requestedCli: 'gemini', isCustomTemplate: false, policy: policy() })
    ).toThrow(/claude, codex/)
  })

  test('explicit disallowed cli on a custom-template agent still throws (explicit is always validated)', () => {
    expect(() =>
      resolveWorkflowCli({
        requestedCli: 'opencode',
        isCustomTemplate: true,
        templateDefaultCommand: 'claude',
        policy: policy(),
      })
    ).toThrow(/opencode/)
  })

  test('blank requestedCli is treated as omitted', () => {
    expect(
      resolveWorkflowCli({
        requestedCli: '   ',
        isCustomTemplate: false,
        policy: policy({ default: 'codex' }),
      })
    ).toBe('codex')
  })
})

describe('normalizeWorkflowCliPolicy (lenient — for the runtime reader)', () => {
  test('keeps a valid policy intact', () => {
    expect(normalizeWorkflowCliPolicy({ default: 'codex', allowed: ['claude', 'codex'] })).toEqual({
      default: 'codex',
      allowed: ['claude', 'codex'],
    })
  })

  test('drops non-canonical entries from allowed and preserves canonical order', () => {
    expect(
      normalizeWorkflowCliPolicy({ default: 'codex', allowed: ['codex', 'bogus', 'claude'] })
    ).toEqual({ default: 'codex', allowed: ['claude', 'codex'] })
  })

  test('empty/all-junk allowed falls back to the full canonical default', () => {
    expect(normalizeWorkflowCliPolicy({ default: 'codex', allowed: [] })).toEqual(
      DEFAULT_WORKFLOW_CLI_POLICY
    )
    expect(normalizeWorkflowCliPolicy({ default: 'codex', allowed: ['nope'] })).toEqual(
      DEFAULT_WORKFLOW_CLI_POLICY
    )
  })

  test('default not in (sanitized) allowed is coerced to the first allowed entry', () => {
    expect(normalizeWorkflowCliPolicy({ default: 'gemini', allowed: ['claude', 'codex'] })).toEqual(
      { default: 'claude', allowed: ['claude', 'codex'] }
    )
  })

  test('non-object input yields the canonical default', () => {
    expect(normalizeWorkflowCliPolicy(null)).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
    expect(normalizeWorkflowCliPolicy('nope')).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
    expect(normalizeWorkflowCliPolicy(42)).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
  })
})

describe('readWorkflowCliPolicy (storage string → policy)', () => {
  test('null/undefined storage yields the canonical default', () => {
    expect(readWorkflowCliPolicy(null)).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
    expect(readWorkflowCliPolicy(undefined)).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
  })

  test('malformed JSON yields the canonical default rather than throwing', () => {
    expect(readWorkflowCliPolicy('{not json')).toEqual(DEFAULT_WORKFLOW_CLI_POLICY)
  })

  test('valid JSON is parsed and normalized', () => {
    expect(readWorkflowCliPolicy(JSON.stringify({ default: 'codex', allowed: ['codex'] }))).toEqual(
      { default: 'codex', allowed: ['codex'] }
    )
  })
})

describe('assertValidWorkflowCliPolicy (strict — for the settings API)', () => {
  test('returns the clean policy for valid input', () => {
    expect(
      assertValidWorkflowCliPolicy({ default: 'codex', allowed: ['claude', 'codex'] })
    ).toEqual({ default: 'codex', allowed: ['claude', 'codex'] })
  })

  test('rejects a non-object', () => {
    expect(() => assertValidWorkflowCliPolicy(null)).toThrow()
    expect(() => assertValidWorkflowCliPolicy('x')).toThrow()
  })

  test('rejects allowed that is not an array / is empty', () => {
    expect(() => assertValidWorkflowCliPolicy({ default: 'codex', allowed: 'codex' })).toThrow()
    expect(() => assertValidWorkflowCliPolicy({ default: 'codex', allowed: [] })).toThrow()
  })

  test('rejects a non-canonical entry in allowed', () => {
    expect(() =>
      assertValidWorkflowCliPolicy({ default: 'codex', allowed: ['codex', 'bogus'] })
    ).toThrow(/bogus/)
  })

  test('rejects a default missing or not in allowed', () => {
    expect(() => assertValidWorkflowCliPolicy({ allowed: ['codex'] })).toThrow()
    expect(() => assertValidWorkflowCliPolicy({ default: 'claude', allowed: ['codex'] })).toThrow(
      /claude/
    )
  })
})

describe('canonical set + default', () => {
  test('the canonical CLI set matches the supported command presets', () => {
    expect([...CANONICAL_WORKFLOW_CLIS]).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'hermes',
      'qwen',
      'pi',
      'agy',
    ])
  })

  test('the default policy is unrestricted and defaults to claude (backward compatible)', () => {
    expect(DEFAULT_WORKFLOW_CLI_POLICY.default).toBe('claude')
    expect(DEFAULT_WORKFLOW_CLI_POLICY.allowed).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'hermes',
      'qwen',
      'pi',
      'agy',
    ])
  })
})
