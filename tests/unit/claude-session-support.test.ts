import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'
import { withPresetResumeArgs } from '../../src/server/claude-session-support.js'
import { isResumeLaunchConfig } from '../../src/server/preset-launch-support.js'
import {
  captureClaudeSessionId,
  encodeClaudeProjectPath,
  hasClaudeSessionFile,
  resetClaudeSessionClaimsForTests,
  snapshotClaudeSessionIds,
} from '../../src/server/session-capture-claude.js'

const tempDirs: string[] = []
const presetCapture = {
  source: 'claude_project_jsonl_dir' as const,
  pattern: '~/.claude/projects/{encoded_cwd}/*.jsonl',
}

const createTempRoot = () => {
  const root = join(tmpdir(), `hive-claude-session-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  process.env.HIVE_CLAUDE_PROJECTS_DIR = root
  return root
}

const writeSession = (root: string, cwd: string, sessionId: string, content = '{}\n') => {
  const projectDir = join(root, encodeClaudeProjectPath(cwd))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), content)
}

afterEach(() => {
  delete process.env.HIVE_CLAUDE_PROJECTS_DIR
  resetClaudeSessionClaimsForTests()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe('claude session support', () => {
  test('encodeClaudeProjectPath handles Windows separators', () => {
    expect(encodeClaudeProjectPath('C:\\Users\\admin\\project')).toBe('C--Users-admin-project')
  })

  // The encoding must MATCH what Claude Code itself produces for the project
  // metadata directory under `~/.claude/projects/`. Otherwise Hive looks in
  // one directory while Claude wrote to another, and session resume silently
  // fails. The character set below was determined empirically by running
  // `claude --print "x"` in test directories with each character and
  // observing the directory name Claude Code created.
  test('encodeClaudeProjectPath replaces every non-alphanumeric non-hyphen character (empirically matched against Claude Code)', () => {
    // Every char in this string EXCEPT letters/digits/hyphen must become `-`,
    // exactly one dash per source character (no collapsing).
    expect(encodeClaudeProjectPath('/tmp/foo_bar')).toBe('-tmp-foo-bar')
    expect(encodeClaudeProjectPath('/tmp/foo.bar')).toBe('-tmp-foo-bar')
    expect(encodeClaudeProjectPath('/tmp/with space dir')).toBe('-tmp-with-space-dir')
    expect(encodeClaudeProjectPath('/tmp/foo(paren)+plus')).toBe('-tmp-foo-paren--plus')
    expect(encodeClaudeProjectPath('/tmp/at@hash#amp&')).toBe('-tmp-at-hash-amp-')
    expect(encodeClaudeProjectPath('/tmp/[brk]')).toBe('-tmp--brk-')
  })

  test('encodeClaudeProjectPath preserves literal hyphens (so `mirofish-frontend` stays intact)', () => {
    expect(encodeClaudeProjectPath('/Users/admin/code/mirofish-frontend')).toBe(
      '-Users-admin-code-mirofish-frontend'
    )
  })

  test('encodeClaudeProjectPath replaces non-ASCII characters one-for-one', () => {
    // Windows usernames with Chinese characters (`C:\Users\张三\project`) are
    // a known case where the previous Hive regex left CJK chars intact while
    // Claude Code replaced them with `-`. Verified empirically against
    // `claude --print` in a CJK-named directory.
    expect(encodeClaudeProjectPath('/tmp/张三')).toBe('-tmp---')
    expect(encodeClaudeProjectPath('C:\\Users\\张三\\project')).toBe('C--Users----project')
  })

  test('snapshotClaudeSessionIds returns an empty set when the project directory is missing', () => {
    createTempRoot()

    expect(snapshotClaudeSessionIds('/tmp/missing-project')).toEqual(new Set())
  })

  test('snapshotClaudeSessionIds returns only jsonl session ids', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-a'
    writeSession(root, cwd, '11111111-1111-4111-8111-111111111111')
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    writeFileSync(join(projectDir, 'not-a-session.txt'), 'ignore')

    expect(snapshotClaudeSessionIds(cwd)).toEqual(new Set(['11111111-1111-4111-8111-111111111111']))
  })

  test('snapshotClaudeSessionIds ignores malformed jsonl names', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-b'
    const projectDir = join(root, encodeClaudeProjectPath(cwd))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'bad.jsonl'), '{}\n')

    expect(snapshotClaudeSessionIds(cwd)).toEqual(new Set())
  })

  test('captureClaudeSessionId resolves undefined when no new id appears before timeout', async () => {
    createTempRoot()
    const captured: string[] = []

    await captureClaudeSessionId(
      '/tmp/project-c',
      new Set(),
      (sessionId) => captured.push(sessionId),
      10,
      1
    )

    expect(captured).toEqual([])
  })

  test('captureClaudeSessionId captures a new session id', async () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-d'
    writeSession(root, cwd, '22222222-2222-4222-8222-222222222222')
    const captured: string[] = []

    await captureClaudeSessionId(cwd, new Set(), (sessionId) => captured.push(sessionId), 50, 1)

    expect(captured).toEqual(['22222222-2222-4222-8222-222222222222'])
  })

  test('captureClaudeSessionId skips ids already present in the startup snapshot', async () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-e'
    writeSession(root, cwd, '33333333-3333-4333-8333-333333333333')
    const captured: string[] = []
    setTimeout(() => writeSession(root, cwd, '44444444-4444-4444-8444-444444444444'), 5)

    await captureClaudeSessionId(
      cwd,
      new Set(['33333333-3333-4333-8333-333333333333']),
      (sessionId) => captured.push(sessionId),
      50,
      1
    )

    expect(captured).toEqual(['44444444-4444-4444-8444-444444444444'])
  })

  test('withPresetResumeArgs returns original config when no last session exists', () => {
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: presetCapture,
    }

    expect(withPresetResumeArgs(config, null, undefined)).toBe(config)
  })

  test('withPresetResumeArgs adds resume args when the session file exists', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-f'
    writeSession(root, cwd, '55555555-5555-4555-8555-555555555555')

    expect(
      withPresetResumeArgs(
        {
          command: 'claude',
          args: ['--dangerously-skip-permissions'],
        },
        {
          resumeArgsTemplate: '--resume {session_id}',
          sessionIdCapture: presetCapture,
          yoloArgsTemplate: null,
        },
        '55555555-5555-4555-8555-555555555555',
        cwd
      )
    ).toMatchObject({
      args: ['--resume', '55555555-5555-4555-8555-555555555555', '--dangerously-skip-permissions'],
      resumedSessionId: '55555555-5555-4555-8555-555555555555',
    })
  })

  test('withPresetResumeArgs returns original config when the session file is stale', () => {
    createTempRoot()
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: presetCapture,
    }

    expect(
      withPresetResumeArgs(config, null, '66666666-6666-4666-8666-666666666666', '/tmp/project-g')
    ).toBe(config)
    expect(hasClaudeSessionFile('/tmp/project-g', '66666666-6666-4666-8666-666666666666')).toBe(
      false
    )
  })

  test('withPresetResumeArgs skips Claude resume when the session file belongs to another worker', () => {
    const root = createTempRoot()
    const cwd = '/tmp/project-owner-check'
    const sessionId = '88888888-8888-4888-8888-888888888888'
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: presetCapture,
    }
    writeSession(root, cwd, sessionId, 'You are Bob (coder) in workspace Demo.\n')
    const invalidSessionIds: string[] = []

    const result = withPresetResumeArgs(
      config,
      null,
      sessionId,
      cwd,
      {
        contentIncludes: 'You are Alice (coder) in workspace Demo.',
      },
      (invalidSessionId) => invalidSessionIds.push(invalidSessionId)
    )

    expect(result).toMatchObject({
      args: ['--dangerously-skip-permissions'],
    })
    expect(result).not.toHaveProperty('resumedSessionId')
    expect(invalidSessionIds).toEqual([sessionId])
  })

  test('withPresetResumeArgs trusts Codex last_session_id without a filesystem preflight', () => {
    const result = withPresetResumeArgs(
      {
        command: 'codex',
        args: [],
      },
      {
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          source: 'codex_session_jsonl_dir',
          pattern: '~/.codex/sessions/**/*.jsonl',
        },
        yoloArgsTemplate: null,
      },
      '019dc277-0e8e-75c1-9794-94929426288e',
      '/tmp/no-such-codex-workspace'
    )

    expect(result).toMatchObject({
      args: ['resume', '019dc277-0e8e-75c1-9794-94929426288e'],
      resumedSessionId: '019dc277-0e8e-75c1-9794-94929426288e',
    })
  })

  test('withPresetResumeArgs normalizes stale Windows Codex node entrypoints before injecting yolo args', () => {
    const result = withPresetResumeArgs(
      {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Users\\zzy\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
          '--model',
          'gpt-5',
        ],
        commandPresetId: 'codex',
        interactiveCommand: 'C:\\Program Files\\nodejs\\node.exe',
      },
      {
        command: 'codex',
        id: 'codex',
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          source: 'codex_session_jsonl_dir',
          pattern: '~/.codex/sessions/**/*.jsonl',
        },
        yoloArgsTemplate: ['--dangerously-bypass-approvals-and-sandbox'],
      },
      undefined,
      'C:\\repo'
    )

    expect(result).toMatchObject({
      command: 'codex',
      args: ['--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5'],
      interactiveCommand: 'codex',
    })
  })

  test('withPresetResumeArgs keeps Codex resume args after the normalized CLI command', () => {
    const result = withPresetResumeArgs(
      {
        command: 'C:/Program Files/nodejs/node.exe',
        args: ['C:/Users/zzy/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js'],
        commandPresetId: 'codex',
      },
      {
        command: 'codex',
        id: 'codex',
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          source: 'codex_session_jsonl_dir',
          pattern: '~/.codex/sessions/**/*.jsonl',
        },
        yoloArgsTemplate: ['--dangerously-bypass-approvals-and-sandbox'],
      },
      '019dc277-0e8e-75c1-9794-94929426288e',
      'C:/repo'
    )

    expect(result).toMatchObject({
      command: 'codex',
      args: [
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        '019dc277-0e8e-75c1-9794-94929426288e',
      ],
      resumedSessionId: '019dc277-0e8e-75c1-9794-94929426288e',
    })
  })

  test('withPresetResumeArgs does not duplicate an existing Codex resume subcommand when yolo args are injected', () => {
    const result = withPresetResumeArgs(
      {
        command: 'codex',
        args: ['resume', 'existing-session'],
      },
      {
        command: 'codex',
        id: 'codex',
        resumeArgsTemplate: 'resume {session_id}',
        sessionIdCapture: {
          source: 'codex_session_jsonl_dir',
          pattern: '~/.codex/sessions/**/*.jsonl',
        },
        yoloArgsTemplate: ['--dangerously-bypass-approvals-and-sandbox'],
      },
      '019dc277-0e8e-75c1-9794-94929426288e',
      '/tmp/project'
    )

    expect(result).toMatchObject({
      args: ['--dangerously-bypass-approvals-and-sandbox', 'resume', 'existing-session'],
    })
    expect(result).not.toHaveProperty('resumedSessionId')
  })

  test('withPresetResumeArgs leaves node entrypoints untouched without a Codex preset binding', () => {
    const config = {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Users\\zzy\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
    }

    expect(withPresetResumeArgs(config, null, undefined, 'C:\\repo')).toBe(config)
  })

  test('withPresetResumeArgs skips resume when capture source is unknown', () => {
    const config = {
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
    }
    const result = withPresetResumeArgs(
      config,
      {
        resumeArgsTemplate: '--resume {session_id}',
        sessionIdCapture: {
          source: 'future_unknown',
          pattern: '~/.future/{session_id}',
        } as never,
        yoloArgsTemplate: null,
      },
      '77777777-7777-4777-8777-777777777777',
      '/tmp/project-h'
    )

    expect(result).toMatchObject({
      args: ['--dangerously-skip-permissions'],
    })
    expect(result).not.toHaveProperty('resumedSessionId')
  })

  test('isResumeLaunchConfig detects direct resume args', () => {
    expect(isResumeLaunchConfig({ command: 'claude', args: ['--resume', 'session-id'] })).toBe(true)
    expect(isResumeLaunchConfig({ command: 'codex', args: ['resume', 'session-id'] })).toBe(true)
  })

  test('isResumeLaunchConfig detects shell startup resume commands', () => {
    expect(
      isResumeLaunchConfig({
        command: '/bin/zsh',
        args: ['-lic', 'claude --resume f500de1d-df89-470f-a2ce-e385acffef19'],
        interactiveCommand: 'claude',
      })
    ).toBe(true)
    expect(
      isResumeLaunchConfig({
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', 'claude --continue --label "old session"'],
        interactiveCommand: 'claude',
      })
    ).toBe(true)
  })

  test('isResumeLaunchConfig does not treat unrelated shell text as this CLI resume', () => {
    expect(
      isResumeLaunchConfig({
        command: '/bin/zsh',
        args: ['-lic', 'echo --resume'],
        interactiveCommand: 'claude',
      })
    ).toBe(false)
  })
})
