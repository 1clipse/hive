# M0 — Per-Agent Stdin Write Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize all stdin writes to a given agent so two writers (UI + orchestrator, or orchestrator + workflow runner) can never interleave a bracketed-paste/submit sequence, without changing the synchronous error contract callers depend on.

**Architecture:** `post-start-input-writer.ts` gains an awaitable completion signal (its function returns a `Promise<void>` that resolves when the full paste→submit sequence finishes), while keeping its synchronous initial-attempt throw and exact timing. `agent-stdin-dispatcher.ts` adds a per-`agentId` serial queue (a `busy` flag + FIFO): an uncontended write runs synchronously (so an immediate failure still throws to the caller); a contended write is enqueued and runs only after the in-flight write's sequence resolves. `requireActiveRun` is checked synchronously at call time so `writeSendPrompt` still throws when there is no live run.

**Tech Stack:** Node 22 ESM, TypeScript, Vitest, Biome. No new dependencies.

**Why this is M0 (prerequisite + standalone fix):** This race exists today (a UI button write + an orchestrator write to the same orchestrator PTY can interleave). It must be fixed before the workflow runner becomes a third concurrent writer. It ships and is verifiable on its own.

---

## Spec references

- Spec §5 "Stdin write serialization (M0 — prerequisite)".
- Blocking finding B2.

## Background facts (verified against current code)

- `agent-stdin-dispatcher.ts` `writeToActiveAgentRun` (line ~84) resolves the newest active run for an agent, then calls either `createPostStartInputWriter(...)(runId, text)` (interactive CLIs) or `agentManager.writeInput(runId, text)` (others). It is **synchronous** and may throw `PtyInactiveError`.
- `createPostStartInputWriter(agentManager, command)` returns `(runId, text) => void`. The interactive path polls for prompt-ready, writes a bracketed paste, then schedules the submit `\r` via `setTimeout` (in `submitPastedInteractiveInput`). It currently gives **no completion signal**.
- Consumers (`team-operations.ts`): `dispatchTask` calls `writeSendPrompt` and on a thrown error deletes the dispatch + message and rethrows (relies on a **synchronous throw** — see `tests/unit/agent-runtime-races.test.ts` "failed stdin write surfaces PtyInactiveError"). `cancelTask`/`statusTask`/`reportTask` each wrap their write in a **synchronous** `try/catch` that records `forwardError`.
- These methods are exposed through `agent-runtime.ts` and typed in `agent-runtime-contract.ts` as returning `void`. **Their `void` return type and synchronous semantics must not change.**

## File structure

- Modify: `src/server/post-start-input-writer.ts` — `createPostStartInputWriter` returns `Promise<void>`; `submitPastedInteractiveInput` takes an `onDone` callback. Responsibility unchanged (write post-start input); only adds a completion signal.
- Modify: `src/server/agent-stdin-dispatcher.ts` — add the per-agent serial queue around the existing write logic. Public method signatures unchanged (still return `void`, still throw synchronously when uncontended).
- Test: `tests/unit/post-start-input-writer.test.ts` — add cases asserting the returned promise resolves at sequence end; keep all existing timing assertions green.
- Test (new): `tests/unit/agent-stdin-write-queue.test.ts` — the serializer: ordering, cross-agent independence, uncontended sync throw.

No DB, no schema, no UI changes in M0.

---

## Task 1: `createPostStartInputWriter` returns a completion promise (non-interactive branch)

**Files:**
- Modify: `src/server/post-start-input-writer.ts:117-125`
- Test: `tests/unit/post-start-input-writer.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('post-start input writer', ...)`:

```ts
test('non-interactive writer resolves its completion promise after the immediate write', async () => {
  const manager = {
    getRun: vi.fn(() => ({ output: '', status: 'running' })),
    writeInput: vi.fn(),
  }
  const write = createPostStartInputWriter(manager as never, process.execPath)
  const done = write('run-1', 'payload')
  expect(done).toBeInstanceOf(Promise)
  await expect(done).resolves.toBeUndefined()
  expect(manager.writeInput).toHaveBeenCalledWith('run-1', 'payload\n')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/post-start-input-writer.test.ts -t "non-interactive writer resolves"`
Expected: FAIL — `done` is `undefined`, not a Promise (`expect(undefined).toBeInstanceOf(Promise)`).

- [ ] **Step 3: Make the non-interactive branch return a resolved promise**

Replace the non-interactive branch (currently returns `void`):

```ts
export const createPostStartInputWriter = (
  agentManager: AgentManager,
  command: string
): ((runId: string, text: string) => Promise<void>) => {
  if (!isInteractiveAgentCommand(command)) {
    return (runId, text) => {
      // Synchronous write; an EPIPE/inactive failure still throws synchronously
      // (before the promise is returned), preserving the dispatcher's contract.
      writeIfRunWritable(agentManager, runId, `${text}\n`)
      return Promise.resolve()
    }
  }
  // interactive branch updated in Task 2
  return (runId, text) => {
    const startedAt = Date.now()
    let isInitialAttempt = true
    const tryWrite = () => {
      let output: string | null
      try {
        const run = agentManager.getRun(runId)
        output = isWritableRunStatus(run.status) ? run.output : null
      } catch {
        return
      }
      if (output === null) return
      if (
        hasInteractivePromptReady(output, command) ||
        (canTimeoutBeforePromptReady(command) && Date.now() - startedAt >= READY_TIMEOUT_MS)
      ) {
        const baselineLength = output.length
        const input = usesBracketedPaste(command) ? toBracketedPasteSubmission(text) : text
        try {
          if (!writeIfRunWritable(agentManager, runId, input)) return
        } catch (error) {
          if (isInitialAttempt) throw error
          return
        }
        submitPastedInteractiveInput(
          agentManager,
          runId,
          text,
          baselineLength,
          isClaudeCommand(command)
        )
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    try {
      tryWrite()
    } finally {
      isInitialAttempt = false
    }
    return Promise.resolve()
  }
}
```

Note: the interactive branch here still returns an immediately-resolved promise — Task 2 makes it resolve only at true sequence end. Splitting keeps each step small.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/post-start-input-writer.test.ts`
Expected: PASS (new test + all existing timing tests still green — they ignore the return value).

- [ ] **Step 5: Commit**

```bash
git add src/server/post-start-input-writer.ts tests/unit/post-start-input-writer.test.ts
git commit -m "Return a completion promise from the post-start input writer"
```

---

## Task 2: Resolve the interactive completion promise only at true sequence end

**Files:**
- Modify: `src/server/post-start-input-writer.ts` (`submitPastedInteractiveInput` + interactive branch)
- Test: `tests/unit/post-start-input-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('interactive writer resolves its promise only after the submit Enter fires', async () => {
  vi.useFakeTimers()
  let output = 'Welcome back\n❯ '
  const manager = {
    getRun: vi.fn(() => ({ output, status: 'running' })),
    writeInput: vi.fn(),
  }
  const write = createPostStartInputWriter(manager as never, 'claude')
  const done = write('run-1', 'payload')
  let settled = false
  void done.then(() => { settled = true })

  // paste written, submit not yet fired → not settled
  expect(manager.writeInput).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(settled).toBe(false)

  output += '[Pasted text #1 +1 lines]\n'
  vi.advanceTimersByTime(750) // min delay (600) + ack settle (100) + slack
  expect(manager.writeInput).toHaveBeenCalledTimes(2) // the \r submit
  await Promise.resolve()
  expect(settled).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/post-start-input-writer.test.ts -t "resolves its promise only after the submit"`
Expected: FAIL — `settled` is `true` immediately (Task 1 resolved eagerly), so the `expect(settled).toBe(false)` assertion fails.

- [ ] **Step 3: Thread an `onDone` callback to every terminal point**

Change `submitPastedInteractiveInput` signature and call `onDone()` at each terminal (submit fired, or run no longer writable):

```ts
const submitPastedInteractiveInput = (
  agentManager: AgentManager,
  runId: string,
  text: string,
  baselineLength: number,
  waitForPasteAck: boolean,
  onDone: () => void
) => {
  const pastedAt = Date.now()
  const minDelay = getSubmitAfterPasteDelayMs(text)
  let acknowledgedAt: number | null = null

  const getWritableOutput = () => {
    try {
      const run = agentManager.getRun(runId)
      return isWritableRunStatus(run.status) ? run.output : null
    } catch {
      return null
    }
  }

  const submit = () => {
    try {
      writeIfRunWritable(agentManager, runId, '\r')
    } catch {
      // The PTY may have exited between paste and submit.
    }
  }

  const trySubmit = () => {
    if (!waitForPasteAck) {
      submit()
      onDone()
      return
    }
    const output = getWritableOutput()
    if (output === null) {
      onDone() // run exited; sequence is over
      return
    }
    if (acknowledgedAt === null && hasBracketedPasteAcknowledgement(output, baselineLength)) {
      acknowledgedAt = Date.now()
    }
    const elapsed = Date.now() - pastedAt
    const ackSettled =
      acknowledgedAt !== null && Date.now() - acknowledgedAt >= PASTE_ACK_SETTLE_DELAY_MS
    if ((ackSettled && elapsed >= minDelay) || elapsed >= PASTE_ACK_TIMEOUT_MS) {
      submit()
      onDone()
      return
    }
    setTimeout(trySubmit, PASTE_ACK_CHECK_INTERVAL_MS)
  }

  setTimeout(trySubmit, minDelay)
}
```

- [ ] **Step 4: Make the interactive branch resolve via `onDone`**

Replace the interactive branch's body so the promise is created with an externally-captured resolver, `tryWrite()` runs synchronously (preserving the initial-attempt throw), and resolution flows through `onDone`/terminal `return`s:

```ts
  return (runId, text) => {
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const startedAt = Date.now()
    let isInitialAttempt = true
    const tryWrite = () => {
      let output: string | null
      try {
        const run = agentManager.getRun(runId)
        output = isWritableRunStatus(run.status) ? run.output : null
      } catch {
        resolveDone()
        return
      }
      if (output === null) {
        resolveDone()
        return
      }
      if (
        hasInteractivePromptReady(output, command) ||
        (canTimeoutBeforePromptReady(command) && Date.now() - startedAt >= READY_TIMEOUT_MS)
      ) {
        const baselineLength = output.length
        const input = usesBracketedPaste(command) ? toBracketedPasteSubmission(text) : text
        try {
          if (!writeIfRunWritable(agentManager, runId, input)) {
            resolveDone()
            return
          }
        } catch (error) {
          if (isInitialAttempt) throw error // synchronous throw on first attempt
          resolveDone()
          return
        }
        submitPastedInteractiveInput(
          agentManager,
          runId,
          text,
          baselineLength,
          isClaudeCommand(command),
          resolveDone
        )
        return
      }
      setTimeout(tryWrite, READY_CHECK_INTERVAL_MS)
    }
    try {
      tryWrite() // runs synchronously; an initial-attempt throw propagates to the caller
    } finally {
      isInitialAttempt = false
    }
    return done
  }
```

Key point: `tryWrite()` is invoked **outside** the `new Promise` executor, so an initial-attempt `throw` propagates synchronously (the `done` promise is simply never returned in that case) — the dispatcher's synchronous-throw contract is preserved. `resolveDone` was captured during the synchronous executor run.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/post-start-input-writer.test.ts`
Expected: PASS — the new resolution test passes and every existing timing test (exact `writeInput` call counts at fixed `advanceTimersByTime` offsets) is unchanged, because timing logic is untouched; only `onDone()` calls were added at points that already existed.

- [ ] **Step 6: Commit**

```bash
git add src/server/post-start-input-writer.ts tests/unit/post-start-input-writer.test.ts
git commit -m "Resolve the post-start writer promise at paste-submit completion"
```

---

## Task 3: Per-agent serial queue in the stdin dispatcher

**Files:**
- Modify: `src/server/agent-stdin-dispatcher.ts:77-186`
- Test (new): `tests/unit/agent-stdin-write-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-stdin-write-queue.test.ts`. It drives the real dispatcher with an injected fake `agentManager` whose interactive write resolves on a controllable signal, and asserts (a) a second write to the same agent does not paste until the first sequence resolves, (b) writes to different agents run concurrently, (c) an uncontended write with no active run throws synchronously.

```ts
import { describe, expect, test, vi } from 'vitest'

import { createAgentStdinDispatcher } from '../../src/server/agent-stdin-dispatcher.js'
import { PtyInactiveError } from '../../src/server/http-errors.js'

type Run = { agentId: string; runId: string; startedAt: number; status: string; output: string }

const makeHarness = () => {
  const runs: Run[] = []
  const writes: Array<{ runId: string; text: string }> = []
  // Each interactive write is "in flight" until we resolve it by appending a
  // sentinel to the run output that the writer treats as paste-ack + advancing
  // timers — but to keep the unit test deterministic we instead make the fake
  // agentManager record writes and expose a manual gate.
  const agentManager = {
    getRun: (runId: string) => {
      const r = runs.find((x) => x.runId === runId)
      if (!r) throw new Error(`no run ${runId}`)
      return r
    },
    writeInput: (runId: string, text: string) => {
      writes.push({ runId, text })
    },
  }
  const registry = { list: () => runs.map((r) => ({ ...r })) }
  const dispatcher = createAgentStdinDispatcher({
    agentManager: agentManager as never,
    getLaunchConfig: () => ({ command: '/bin/bash', args: [] }), // non-interactive → immediate, promise resolves now
    getWorkspaceId: (agentId: string) => agentId.split(':')[0],
    registry: registry as never,
    syncRun: (run) => run,
  })
  return { runs, writes, dispatcher }
}

describe('per-agent stdin write queue', () => {
  test('uncontended write to an agent with no active run throws synchronously (send contract)', () => {
    const { dispatcher } = makeHarness() // no runs registered
    expect(() =>
      dispatcher.writeSendPrompt('ws', 'ws:w1', 'd1', 'Orchestrator', 'Coder', 'do it')
    ).toThrow(PtyInactiveError)
  })

  test('writes to the same agent are delivered in call order', async () => {
    const { runs, writes, dispatcher } = makeHarness()
    runs.push({ agentId: 'ws:orchestrator', runId: 'r1', startedAt: 1, status: 'running', output: 'x' })
    dispatcher.writeUserInputPrompt('ws', 'FIRST')
    dispatcher.writeUserInputPrompt('ws', 'SECOND')
    // Non-interactive writer resolves on a microtask; flush the queue.
    await new Promise((r) => setTimeout(r, 0))
    const order = writes.filter((w) => w.runId === 'r1').map((w) => w.text)
    expect(order[0]).toContain('FIRST')
    expect(order[1]).toContain('SECOND')
    // FIRST must fully precede SECOND (no interleaving).
    expect(order.findIndex((t) => t.includes('FIRST'))).toBeLessThan(
      order.findIndex((t) => t.includes('SECOND'))
    )
  })

  test('writes to different agents are not blocked by each other', async () => {
    const { runs, writes, dispatcher } = makeHarness()
    runs.push({ agentId: 'ws:orchestrator', runId: 'r1', startedAt: 1, status: 'running', output: 'x' })
    runs.push({ agentId: 'ws:w2', runId: 'r2', startedAt: 1, status: 'running', output: 'x' })
    dispatcher.writeUserInputPrompt('ws', 'ORCH')
    dispatcher.writeCancelPrompt('ws', 'ws:w2', 'd9', 'stop')
    await new Promise((r) => setTimeout(r, 0))
    expect(writes.some((w) => w.runId === 'r1')).toBe(true)
    expect(writes.some((w) => w.runId === 'r2')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/agent-stdin-write-queue.test.ts`
Expected: FAIL — ordering test may pass incidentally for the non-interactive fast path, but the file imports nothing new yet; the real failure target is the ordering guarantee once interactive writes are slow. To make the failing state explicit, this task's red is the **interleaving** case; if all three pass against current code, strengthen the ordering test to use an interactive config with a deferred resolve (see Step 3 note) so current (un-queued) code interleaves and fails.

> Implementer note: current `writeToActiveAgentRun` has no queue, so with a *deferred* interactive writer the second write's paste lands before the first's submit. Use `getLaunchConfig: () => ({ command: 'claude', interactiveCommand: 'claude', args: [] })` and fake timers to force the deferred path, asserting paste order. Keep the harness’ `getRun().output` returning a prompt-ready `❯ ` so the writer pastes immediately but defers the submit.

- [ ] **Step 3: Implement the serial queue**

Rewrite `createAgentStdinDispatcher`'s `writeToActiveAgentRun` into: a synchronous front (resolve active run + `requireActiveRun` check, which may throw) producing a thunk, plus a per-`agentId` `busy`/`queue` serializer that runs thunks one at a time and advances when each returned promise settles.

```ts
export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
}: AgentStdinDispatcherInput) => {
  const chains = new Map<string, { busy: boolean; queue: Array<() => void> }>()
  const getChain = (agentId: string) => {
    let chain = chains.get(agentId)
    if (!chain) {
      chain = { busy: false, queue: [] }
      chains.set(agentId, chain)
    }
    return chain
  }

  // Resolve the live run + enforce requireActiveRun SYNCHRONOUSLY, then return a
  // thunk that performs the actual (possibly deferred) write and returns a
  // promise that settles when the paste→submit sequence is done.
  const prepareWrite = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean }
  ): (() => Promise<void>) => {
    const run = registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return () => Promise.resolve()
    }
    return () => {
      try {
        const config = getLaunchConfig(workspaceId, agentId)
        if (agentManager && config) {
          return (
            createPostStartInputWriter(agentManager, config.interactiveCommand ?? config.command)(
              run.runId,
              text
            ) ?? Promise.resolve()
          )
        }
        agentManager?.writeInput(run.runId, text)
        return Promise.resolve()
      } catch (error) {
        throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const drain = (agentId: string) => {
    const chain = getChain(agentId)
    if (chain.busy) return
    const next = chain.queue.shift()
    if (!next) return
    chain.busy = true
    next()
  }

  const runThunk = (agentId: string, thunk: () => Promise<void>) => {
    const chain = getChain(agentId)
    void Promise.resolve()
      .then(thunk)
      .catch(() => {
        // A deferred write failing (e.g. PTY died while queued) must not crash
        // the runtime; the synchronous path already surfaced contended-at-call
        // failures. Swallow and continue draining.
      })
      .finally(() => {
        chain.busy = false
        drain(agentId)
      })
  }

  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ) => {
    // SYNCHRONOUS: resolve run + requireActiveRun throw happens here, in the
    // caller's stack, preserving writeSendPrompt's throw contract.
    const thunk = prepareWrite(workspaceId, agentId, text, input)
    const chain = getChain(agentId)
    if (chain.busy) {
      chain.queue.push(() => runThunk(agentId, thunk))
      return
    }
    chain.busy = true
    let promise: Promise<void>
    try {
      promise = thunk() // uncontended: run synchronously; immediate failure throws
    } catch (error) {
      chain.busy = false
      drain(agentId)
      throw error
    }
    void promise
      .catch(() => {})
      .finally(() => {
        chain.busy = false
        drain(agentId)
      })
  }

  // ... build*Payload exports and the five public methods are UNCHANGED below ...
```

The five public methods (`writeReportPrompt` / `writeStatusPrompt` / `writeSendPrompt` / `writeCancelPrompt` / `writeUserInputPrompt`) keep their exact current bodies — they already call `writeToActiveAgentRun(...)`. The `build*Payload` exported helpers are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/agent-stdin-write-queue.test.ts tests/unit/agent-stdin-dispatcher-payload.test.ts tests/unit/agent-runtime-races.test.ts`
Expected: PASS — ordering + cross-agent independence hold; `agent-runtime-races` "failed stdin write surfaces PtyInactiveError" still passes because the failing send is uncontended → `thunk()` runs synchronously → throws.

- [ ] **Step 5: Commit**

```bash
git add src/server/agent-stdin-dispatcher.ts tests/unit/agent-stdin-write-queue.test.ts
git commit -m "Serialize stdin writes per agent to prevent paste interleaving"
```

---

## Task 4: Full-suite regression gate

**Files:** none (verification only)

- [ ] **Step 1: Run the type/lint/test gate**

Run: `pnpm check && pnpm test`
Expected: Biome clean; all tests pass (notably `tests/server/*` team/dispatch integration tests, which exercise the real send→report flow through the dispatcher, stay green — the serializer is transparent to the uncontended path they use).

- [ ] **Step 2: Commit (only if any incidental fix was needed)**

```bash
git add -A
git commit -m "Fix fallout from per-agent stdin write serialization"
```

(If the suite is green with no changes, skip this commit.)

---

## Self-review

- **Spec coverage:** Spec §5 (per-agent stdin write queue, B2) → Tasks 1-3. The "writes to different agents stay concurrent" requirement → Task 3 Step 1 test 3. The "fixes today's UI-vs-orch race" claim → covered by the ordering test (two writes to `ws:orchestrator`).
- **Placeholder scan:** none. Every code step shows full code; Task 2 Step 4 shows the complete interactive branch; Task 3 Step 3 shows the complete serializer.
- **Type consistency:** `createPostStartInputWriter` return type changes `void → Promise<void>` consistently in Task 1 (signature) and is consumed via `?? Promise.resolve()` in Task 3's `prepareWrite`. `submitPastedInteractiveInput` gains a 6th param `onDone: () => void` (Task 2 Step 3) and is called with `resolveDone` (Task 2 Step 4). The dispatcher public methods keep `void` returns (contract unchanged) — verified against `agent-runtime-contract.ts`.
- **Contract preservation:** synchronous throw for uncontended `writeSendPrompt` (races:124) preserved by running the first thunk synchronously in `writeToActiveAgentRun`; `requireActiveRun` throw moved into the synchronous `prepareWrite`.

## Known trade-off (documented, acceptable)

A **contended** write whose run dies while queued fails silently (swallowed in `runThunk`) instead of throwing to the original caller (which already returned). This only affects the rare "two writes racing the same agent and the target dies between them" case; the dispatch bookkeeping in `team-operations` already ran for the first (in-flight) write. No crash, no interleaving. If this ever matters, a later milestone can surface queued-write failures via the `workflow:dispatch_observed` channel (spec §8).
