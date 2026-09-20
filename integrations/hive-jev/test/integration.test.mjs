import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runBrowserTask } from '../src/browser.mjs'
import { compactMessages, reviewAction, routeTask } from '../src/core.mjs'
import { automaticApproval } from '../src/policy.mjs'

const testRoot = fileURLToPath(new URL('../', import.meta.url))

function fakeAnswer(question) {
  if (question.type === 'choice') {
    const choices = Object.keys(question.criteria)
    return {
      type: 'choice',
      choice: choices[0],
      confidence: 1,
      probabilities: Object.fromEntries(choices.map((choice, index) => [choice, index ? 0 : 1])),
    }
  }
  if (question.type === 'score')
    return { type: 'score', score: 1, confidence: 1, probabilities: { 1: 1 } }
  return { type: 'noul', noul: 0.1 }
}

async function withFakeJev(callback) {
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(payload.questions).map(([key, question]) => [key, fakeAnswer(question)])
        ),
      })
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const before = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL }
  process.env.TYPESAFE_API_KEY = 'test-key'
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`
  try {
    await callback()
  } finally {
    if (before.key === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = before.key
    if (before.url === undefined) delete process.env.TYPESAFE_BASE_URL
    else process.env.TYPESAFE_BASE_URL = before.url
    await new Promise((resolve) => server.close(resolve))
  }
}

test('route recommends only an existing member and never dispatches', async () =>
  withFakeJev(async () => {
    const result = await routeTask({
      task: 'test',
      candidates: [{ id: 'tester', description: 'Existing tester' }],
    })
    assert.equal(result.answers.member.choice, 'tester')
    assert.equal(result.dispatch_executed, false)
  }))

test('route rejects duplicate member IDs before asking Jev', async () => {
  await assert.rejects(
    () =>
      routeTask({
        task: 'test',
        candidates: [
          { id: 'tester', description: 'First' },
          { id: 'tester', description: 'Duplicate' },
        ],
      }),
    /unique/
  )
})

test('compaction returns a copy and never mutates the source', async () =>
  withFakeJev(async () => {
    const messages = [
      {
        role: 'assistant',
        text: '',
        tool_uses: [{ tool_use_id: 'one', tool: 'shell', input: {} }],
        tool_results: [],
      },
      {
        role: 'user',
        text: '',
        tool_uses: [],
        tool_results: [{ tool_use_id: 'one', text: 'large result' }],
      },
      { role: 'user', text: 'keep this text', tool_uses: [], tool_results: [] },
    ]
    const before = JSON.stringify(messages)
    const result = await compactMessages(messages, { preserve_recent_messages: 1 })
    assert.equal(result.source_history_mutated, false)
    assert.equal(JSON.stringify(messages), before)
    assert.equal(result.messages.at(-1).text, 'keep this text')
  }))

test('review auto-approves only clear low-risk actions', async () =>
  withFakeJev(async () => {
    const result = await reviewAction({
      user_request: 'Inspect status',
      allow_auto_approval: true,
      auto_approve_tools: ['status'],
      action: { tool: 'status', arguments: {} },
    })
    assert.equal(result.auto_approved, true)
    assert.equal(result.action_executed, false)
    assert.equal(
      automaticApproval({
        securityDecision: 'caution',
        requiresUserConfirmation: false,
        riskLevel: 0,
      }).auto_approved,
      false
    )
    assert.equal(
      automaticApproval({
        securityDecision: 'clear',
        requiresUserConfirmation: false,
        riskLevel: 0,
        tool: 'status',
        allowedTools: ['status'],
      }).auto_approved,
      false
    )
  }))

test('browser execution requires opt-in and independent acceptance', async () => {
  await assert.rejects(
    () => runBrowserTask({ url: 'https://example.com', goal: 'Open', allow_execution: false }),
    /allow_execution/
  )
  await assert.rejects(
    () => runBrowserTask({ url: 'https://example.com', goal: 'Open', allow_execution: true }),
    /expected outcome/
  )
  const result = await runBrowserTask(
    {
      url: 'https://example.com',
      goal: 'Open',
      allow_execution: true,
      expect_title_contains: 'Fixture',
    },
    { python: process.execPath, runner: path.join(testRoot, 'test', 'fake-browser-runner.mjs') }
  )
  assert.equal(result.accepted, true)
})
