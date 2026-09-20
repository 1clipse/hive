/** Opt-in real Codex PTY check. Uses configured default model and authenticated account.
 * Controller is a script, not a model Orchestrator. No production data/workspace writes.
 * pnpm exec tsx scripts/check-team-collaboration-agents.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runHiveCommand } from '../src/cli/hive.js'

type Runtime = Awaited<ReturnType<typeof runHiveCommand>>
type Row = { id: string; state: string; report_text: string | null }
type Message = {
  id: string
  kind: string
  text: string
  from_agent_id: string
  recipient_agent_id: string
  dispatch_id: string
  source_dispatch_id: string | null
  delivery_state: string
}
const root = await mkdtemp(join(tmpdir(), 'hive-real-agents-'))
const workspace = join(root, 'workspace')
const started = Date.now()
const priorData = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = join(root, 'runtime')
let runtime: Runtime | undefined
let cookie = ''
let workspaceId = ''
let orchestrator = ''
const actors = new Map<string, { id: string; runId: string }>()
const receipt: Record<string, unknown> = {
  root,
  workspace,
  scope:
    'real Codex coder/reviewer PTYs; script-controlled Orchestrator; configured default model; no human UI acceptance',
  stages: [],
}
const stages = receipt.stages as Array<{ name: string; elapsed_ms: number; detail?: unknown }>
const stage = (name: string, detail?: unknown) => {
  stages.push({ name, elapsed_ms: Date.now() - started, detail })
  console.log(name, JSON.stringify(detail ?? ''))
}
const request = async (path: string, body?: object) => {
  const response = await fetch(`http://127.0.0.1:${runtime?.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const team = (actor: string, command: string, body: object) =>
  request(`/api/team/${command}`, {
    project_id: workspaceId,
    from_agent_id: actor,
    token: runtime?.store.peekAgentToken(actor),
    ...body,
  })
const inbox = async (id: string): Promise<{ messages: Message[]; required_seen_seq: number }> =>
  team(orchestrator, 'messages', { dispatch_id: id })
const rows = async (): Promise<Row[]> => request(`/api/ui/workspaces/${workspaceId}/dispatches`)
const waitFor = async <T>(
  label: string,
  check: () => Promise<T | undefined>,
  duration = 180000
): Promise<T> => {
  const deadline = Date.now() + duration
  let nextLog = Date.now() + 30000
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > nextLog) {
      console.log(`waiting: ${label} (${Math.round((Date.now() - started) / 1000)}s total)`)
      nextLog = Date.now() + 30000
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Timeout: ${label}`)
}
const waitReport = (id: string) =>
  waitFor(`report ${id}`, async () =>
    (await rows()).find((row) => row.id === id && row.state === 'reported')
  )
const send = async (name: string, text: string, parent?: string): Promise<string> =>
  (
    await team(orchestrator, 'send', {
      to: name,
      text,
      ...(parent ? { related_to_dispatch_id: parent } : {}),
    })
  ).dispatch_id
const save = async () => {
  if (runtime && workspaceId) {
    receipt.dispatches = await rows()
    const messages: Message[] = []
    for (const row of receipt.dispatches as Row[]) messages.push(...(await inbox(row.id)).messages)
    receipt.messages = [...new Map(messages.map((message) => [message.id, message])).values()]
    receipt.message_count = (receipt.messages as Message[]).length
    receipt.dispatch_count = (receipt.dispatches as Row[]).length
    for (const [name, actor] of actors) {
      const output = await request(`/api/runtime/runs/${actor.runId}`)
      let text = String(output.output ?? '')
      for (const entry of actors.values()) {
        const token = runtime.store.peekAgentToken(entry.id)
        if (token) text = text.split(token).join('[REDACTED_AGENT_TOKEN]')
      }
      await writeFile(join(root, `${name}.terminal.log`), text)
    }
  }
  receipt.duration_ms = Date.now() - started
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
try {
  await mkdir(workspace, { recursive: true })
  await writeFile(
    join(workspace, 'sum.mjs'),
    'export function sum(values) { return values.reduce((total, value) => total + Number(value || 0), 0) }\n'
  )
  await writeFile(
    join(workspace, 'TASK.md'),
    'Small isolated sum CLI fixture. Do not access unrelated files, change agent/model configuration, or print credentials. Existing sum.mjs is intentionally a legacy implementation requiring independent review.\n'
  )
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  const passive = join(root, 'controller.cjs')
  await writeFile(
    passive,
    "process.stdin.resume(); process.stdin.on('data',data=>process.stdout.write(data));\n"
  )
  runtime = await runHiveCommand(['--port', '0'])
  const bootstrap = await fetch(`http://127.0.0.1:${runtime.port}/api/ui/session`)
  cookie = bootstrap.headers.get('set-cookie') ?? ''
  workspaceId = (
    await request('/api/workspaces', {
      name: 'Real model collaboration check',
      path: workspace,
      autostart_orchestrator: false,
    })
  ).id
  orchestrator = `${workspaceId}:orchestrator`
  await request(`/api/workspaces/${workspaceId}/agents/${orchestrator}/config`, {
    command: process.execPath,
    args: [passive],
  })
  const controllerRun = await request(
    `/api/workspaces/${workspaceId}/agents/${orchestrator}/start`,
    { hive_port: String(runtime.port) }
  )
  actors.set('controller', { id: orchestrator, runId: controllerRun.run_id })
  for (const [name, role] of [
    ['Coder', 'coder'],
    ['Reviewer', 'reviewer'],
  ]) {
    const member = await request(`/api/workspaces/${workspaceId}/workers`, { name, role })
    await request(`/api/workspaces/${workspaceId}/agents/${member.id}/config`, {
      command: '/opt/homebrew/bin/codex',
      args: ['--no-alt-screen'],
      env: { NODE_OPTIONS: `--import ${resolve('node_modules/tsx/dist/loader.mjs')}` },
    })
    const run = await request(`/api/workspaces/${workspaceId}/agents/${member.id}/start`, {
      hive_port: String(runtime.port),
    })
    actors.set(name, { id: member.id, runId: run.run_id })
  }
  stage('Started real Codex members; script controller only')
  const coder = actors.get('Coder')?.id
  const reviewer = actors.get('Reviewer')?.id
  assert.ok(coder)
  assert.ok(reviewer)
  const implementation = await send(
    'Coder',
    'Read TASK.md. Phase 1: create cli.mjs that imports existing sum.mjs, parses the single JSON array command argument, and prints the sum. Preserve sum.mjs byte-for-byte during this phase; an independent reviewer will audit the legacy core afterward. Before editing, ask the Orchestrator which JSON values count as numbers using team message --dispatch YOUR_ID --to orchestrator --kind question. This is a real missing requirement: do not guess or report blocked. Wait for its answer; use team messages --dispatch YOUR_ID when needed. After the answer implement cli.mjs, run a basic numeric smoke check, then read your inbox and report with explicit --dispatch and --seen required_seen_seq. No nested agents. Keep work scoped to this tiny directory.'
  )
  const question = await waitFor('coder question', async () =>
    (await inbox(implementation)).messages.find(
      (message) => message.kind === 'question' && message.from_agent_id === coder
    )
  )
  assert.notEqual((await rows()).find((row) => row.id === implementation)?.state, 'reported')
  stage('Real coder question preserved open responsibility', question.id)
  await team(orchestrator, 'message', {
    dispatch_id: implementation,
    kind: 'answer',
    reply_to: question.id,
    text: 'Only finite JavaScript numbers count. Ignore strings, null, booleans, arrays and objects; retain zero and negative numbers. Empty array returns 0. Preserve legacy sum.mjs in this wrapper phase: the following independent review will identify any legacy mismatch. You own cli.mjs only for this phase.',
  })
  await team(orchestrator, 'message', {
    dispatch_id: implementation,
    kind: 'note',
    text: 'Additional wrapper requirement: default a missing argument to [] and print exactly the numeric result followed by newline. Verify node cli.mjs yields 0.',
  })
  const initialReport = await waitReport(implementation)
  stage('Real coder produced wrapper and explicit-seen report', initialReport)
  assert.equal(
    execFileSync(process.execPath, ['cli.mjs'], { cwd: workspace, encoding: 'utf8' }).trim(),
    '0'
  )
  const review = await send(
    'Reviewer',
    `Read TASK.md and inspect cli.mjs/sum.mjs. Required contract: sum only finite JS numbers, ignore other JSON values, preserve zero/negatives, empty and missing input =>0. Do not edit files. First directly ask historical Coder for the Phase 1 ownership boundary using team message --dispatch ${implementation} --from-dispatch YOUR_REVIEW_ID --kind question "Which file were you allowed to modify in Phase 1, and was the legacy core deliberately preserved?". Wait for its real answer without reporting blocked. Then run an independent mixed-input check (include numeric strings and null) and report the actual mismatch with evidence. Read messages before report and supply --seen. Do not accept a verbal claim over executable evidence.`,
    implementation
  )
  const peerQuestion = await waitFor('reviewer historical question', async () =>
    (await inbox(implementation)).messages.find(
      (message) => message.kind === 'question' && message.from_agent_id === reviewer
    )
  )
  const peerAnswer = await waitFor('reported coder historical answer', async () =>
    (await inbox(review)).messages.find(
      (message) => message.kind === 'answer' && message.from_agent_id === coder
    )
  )
  stage('Real reviewer and reported coder exchanged direct question/answer', {
    question: peerQuestion.id,
    answer: peerAnswer.id,
  })
  const reviewReport = await waitReport(review)
  stage('Real reviewer reported findings', reviewReport)
  assert.notEqual(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import {sum} from "./sum.mjs"; process.stdout.write(String(sum([0,2,null,"3",-2])))',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
      }
    ).trim(),
    '0'
  )
  const rework = await send(
    'Coder',
    `Related rework: fix sum.mjs to meet the finite-number-only contract. Reviewer evidence: ${reviewReport.report_text}. You now own sum.mjs; cli.mjs may only be changed if required to preserve wrapper behavior. Run executable checks for [0,2,null,"3",-2]=>0, []=>0, [-2,0,5]=>3, [true,false,{},[],"7"]=>0 and missing argument=>0. Then read inbox and report with dispatch and seen. Do not reopen or report against historical dispatch IDs.`,
    review
  )
  const finalReport = await waitReport(rework)
  const cases: Array<[string | undefined, string]> = [
    [undefined, '0'],
    ['[]', '0'],
    ['[0,2,null,"3",-2]', '0'],
    ['[-2,0,5]', '3'],
    ['[true,false,{},[],"7"]', '0'],
  ]
  for (const [input, expected] of cases)
    assert.equal(
      execFileSync(process.execPath, ['cli.mjs', ...(input === undefined ? [] : [input])], {
        cwd: workspace,
        encoding: 'utf8',
      }).trim(),
      expected
    )
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; assert.equal(sum([0,2,null,"3",-2]),0); assert.equal(sum([true,false,{},[],"7"]),0); assert.equal(sum([Infinity,NaN,-2,5]),3)',
    ],
    { cwd: workspace }
  )
  stage('Real coder related rework passed controller executable assertions', finalReport)
  receipt.outcome = 'passed'
} catch (error) {
  receipt.outcome = 'failed'
  receipt.error = error instanceof Error ? error.stack : String(error)
  console.error(receipt.error)
  process.exitCode = 1
} finally {
  try {
    await save()
  } catch (error) {
    console.error('Evidence save failure', error)
  }
  await runtime?.close()
  if (priorData === undefined) delete process.env.HIVE_DATA_DIR
  else process.env.HIVE_DATA_DIR = priorData
  console.log(`Evidence: ${root}`)
}
