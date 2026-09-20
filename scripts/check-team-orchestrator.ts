/** Opt-in: real Codex Orchestrator + two existing members; one user goal only. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runHiveCommand } from '../src/cli/hive.js'

const root = await mkdtemp(join(tmpdir(), 'hive-real-orchestrator-'))
const workspace = join(root, 'workspace')
const started = Date.now()
const previousData = process.env.HIVE_DATA_DIR
process.env.HIVE_DATA_DIR = join(root, 'runtime')
let runtime: Awaited<ReturnType<typeof runHiveCommand>> | undefined
let cookie = ''
let workspaceId = ''
const runs = new Map<string, { id: string; runId: string }>()
const receipt: Record<string, unknown> = {
  root,
  scope:
    'Three real Codex PTYs. Script supplies exactly one user goal, polls read state, and independently checks final artifacts. No controller dispatches, answers or synthetic reports.',
  goal_count: 0,
  stages: [],
}
const stage = (name: string) => {
  const stages = receipt.stages as Array<{ name: string; elapsed_ms: number }>
  stages.push({ name, elapsed_ms: Date.now() - started })
  console.log(name)
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
const goal = [
  'Fix collect-ids.mjs in this tiny workspace. Use ONLY existing Coder to implement and existing Reviewer to independently verify. Do not create members, use in-CLI subagents, or workflows. You own dispatch, report interpretation, any related rework and final acceptance.',
  'Contract: export collectIds(rows = []). Given an array of JSON values, take id only from non-null plain object rows (arrays invalid). Keep only finite JavaScript number IDs including zero and negatives. Ignore strings, booleans, null, missing IDs and nonfinite numbers; never coerce. Deduplicate numbers preserving first occurrence order. Missing/empty input returns []. Non-array top-level input throws TypeError. Preserve the first numerical value, including negative zero. Do not change user/agent/model config or unrelated files.',
  'Assign Coder ownership of collect-ids.mjs. Ask Reviewer to inspect actual code and run independent executable checks, writing REVIEW.json with verdict, commands and observed results. Reviewer may write that evidence file but must not edit implementation. No test framework is needed. If review finds a bug, assign related rework and obtain appropriate re-verification. Do not equate a report with acceptance.',
  'When actual implementation and independent review satisfy the contract, YOU write FINAL.json with status:"completed", summary, implementation_dispatch_id, review_dispatch_id, checks (nonempty array), artifacts (include collect-ids.mjs and REVIEW.json). Reference actual dispatch IDs/evidence. If genuinely blocked, write status:"blocked" with a reason. This is the only user request; all requirements are stated, so do not wait for more input. Keep communication concise.',
].join('\n')

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(
    join(workspace, 'collect-ids.mjs'),
    'export function collectIds(rows) { return rows.map(row => row.id).filter(Boolean) }\n'
  )
  await writeFile(join(workspace, 'GOAL.md'), goal)
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  runtime = await runHiveCommand(['--port', '0'])
  const bootstrap = await fetch(`http://127.0.0.1:${runtime.port}/api/ui/session`)
  cookie = bootstrap.headers.get('set-cookie') ?? ''
  workspaceId = (
    await request('/api/workspaces', {
      name: 'Real Orchestrator check',
      path: workspace,
      autostart_orchestrator: false,
    })
  ).id
  const members: Array<{ name: string; id: string }> = []
  for (const [name, role] of [
    ['Coder', 'coder'],
    ['Reviewer', 'reviewer'],
  ]) {
    members.push({
      name: String(name),
      id: (await request(`/api/workspaces/${workspaceId}/workers`, { name, role })).id,
    })
  }
  for (const actor of [...members, { name: 'Orchestrator', id: `${workspaceId}:orchestrator` }]) {
    const prefix = `/api/workspaces/${workspaceId}/agents/${actor.id}`
    await request(`${prefix}/config`, {
      command: '/opt/homebrew/bin/codex',
      args: ['--no-alt-screen'],
      env: { NODE_OPTIONS: `--import ${resolve('node_modules/tsx/dist/loader.mjs')}` },
    })
    const run = await request(`${prefix}/start`, { hive_port: String(runtime.port) })
    runs.set(actor.name, { id: actor.id, runId: run.run_id })
  }
  stage('Started three real Codex PTYs with configured default model')
  await request(`/api/workspaces/${workspaceId}/user-input`, { text: goal })
  receipt.goal_count = 1
  stage('Submitted one user goal; script now read-only until final artifact checks')
  let final: Record<string, unknown> | undefined
  let nextLog = Date.now() + 30000
  while (Date.now() - started < 480000) {
    const finalPath = join(workspace, 'FINAL.json')
    if (existsSync(finalPath)) {
      try {
        final = JSON.parse(await readFile(finalPath, 'utf8'))
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      if (final) break
    }
    if (Date.now() >= nextLog) {
      console.log(
        'Waiting for real Orchestrator: ' +
          Math.round((Date.now() - started) / 1000) +
          's; open dispatches=' +
          runtime.store.listOpenDispatches(workspaceId).length
      )
      nextLog = Date.now() + 30000
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(final, 'Real Orchestrator did not produce FINAL.json within eight minutes')
  receipt.final = final
  assert.equal(final.status, 'completed')
  assert.ok(Array.isArray(final.checks) && final.checks.length > 0)
  const dispatches = await request(`/api/ui/workspaces/${workspaceId}/dispatches`)
  const implementation = dispatches.find(
    (row: { id: string }) => row.id === final.implementation_dispatch_id
  )
  const review = dispatches.find((row: { id: string }) => row.id === final.review_dispatch_id)
  assert.ok(implementation)
  assert.ok(review)
  assert.equal(implementation.to_agent_id, runs.get('Coder')?.id)
  assert.equal(review.to_agent_id, runs.get('Reviewer')?.id)
  assert.equal(implementation.state, 'reported')
  assert.equal(review.state, 'reported')
  assert.equal(runtime.store.listWorkers(workspaceId).length, 2)
  assert.equal(runtime.store.listOpenDispatches(workspaceId).length, 0)
  assert.ok(existsSync(join(workspace, 'REVIEW.json')))
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        'import assert from "node:assert/strict"; import {collectIds} from "./collect-ids.mjs";',
        'assert.deepEqual(collectIds(),[]); assert.deepEqual(collectIds([]),[]);',
        'assert.deepEqual(collectIds([{id:0},{id:2},{id:0},{id:-3},{id:2}]),[0,2,-3]);',
        'assert.deepEqual(collectIds([null,[],true,"x",{}, {id:"4"},{id:null},{id:true},{id:NaN},{id:Infinity},{id:-Infinity},{id:5}]),[5]);',
        'assert.throws(()=>collectIds(null),TypeError); assert.throws(()=>collectIds({}),TypeError);',
        'assert.deepEqual(collectIds([{id:1.25},{id:1.25},{id:-0},{id:0}]),[1.25,-0]);',
      ].join('\n'),
    ],
    { cwd: workspace }
  )
  stage('Real Orchestrator completed implementation/review; independent artifact assertions passed')
  receipt.outcome = 'passed'
} catch (error) {
  receipt.outcome = 'failed'
  receipt.error = error instanceof Error ? error.stack : String(error)
  console.error(receipt.error)
  process.exitCode = 1
} finally {
  try {
    if (runtime && workspaceId) {
      receipt.dispatches = await request(`/api/ui/workspaces/${workspaceId}/dispatches`)
      receipt.messages = runtime.store.listWorkspaceDispatchMessages(workspaceId)
      receipt.dispatch_count = (receipt.dispatches as unknown[]).length
      receipt.message_count = (receipt.messages as unknown[]).length
      for (const [name, actor] of runs) {
        const output = await request(`/api/runtime/runs/${actor.runId}`)
        let text = String(output.output ?? '')
        for (const value of runs.values()) {
          const token = runtime.store.peekAgentToken(value.id)
          if (token) text = text.split(token).join('[REDACTED_AGENT_TOKEN]')
        }
        await writeFile(join(root, `${name}.terminal.log`), text)
      }
    }
    receipt.duration_ms = Date.now() - started
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  } finally {
    await runtime?.close()
    if (previousData === undefined) delete process.env.HIVE_DATA_DIR
    else process.env.HIVE_DATA_DIR = previousData
    console.log(`Evidence: ${root}`)
  }
}
