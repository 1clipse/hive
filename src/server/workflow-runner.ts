import { dirname, join } from 'node:path'

import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { assertWindowsSafeFilename } from './windows-filename.js'
import {
  assertWorkflowBudgetActive,
  closeWorkflowAgentBudget,
  createWorkflowAgentBudget,
  createWorkflowAgentCallExecutor,
  type WorkflowAgentBudget,
  type WorkflowAgentExecutorStorePort,
  type WorkflowAgentOptions,
  type WorkflowRoleTemplateResolver,
} from './workflow-agent-call-executor.js'
import type { WorkflowCliPolicy } from './workflow-cli-policy.js'
import { createWorkflowDagLayerTracker } from './workflow-dag-layer-tracker.js'
import type { WorkflowDispatchAwaiter } from './workflow-dispatch-awaiter.js'
import type { WorkflowRunRecord, WorkflowRunStatus } from './workflow-run-store.js'
import { loadWorkflowScriptFile, loadWorkflowScriptSource } from './workflow-script-loader.js'
import { runWorkflowScriptWorker, type WorkflowScriptWorker } from './workflow-script-worker.js'
import { WORKFLOW_VM_WORKER_URL } from './workflow-vm-worker-source.js'
import { getWorkflowAgentId } from './workspace-store-support.js'

// TIER 2 #11 — workflow wall-clock budget. Agent call count and concurrency
// caps live in workflow-agent-call-executor; the duration default is Hive's
// own choice because Claude Code docs don't specify one.
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000
const ACTIVE_AGENT_CALL_CLEANUP_TIMEOUT_MS = 5000

const errorToMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
export interface RunWorkflowInput {
  workspaceId: string
  scriptPath: string
  hivePort: string
  args?: unknown
  /** Agent (usually the orchestrator) that fired this workflow; the runner
   *  notifies its PTY when the run finishes. Optional — workflows fired by
   *  cron / UI have no triggering agent. */
  triggeredByAgentId?: string
  /** TIER 2 #5 — set internally when the runner is spawning a nested
   *  workflow() from inside another run. External callers leave it
   *  undefined; the row goes in as a top-level run. */
  parentRunId?: string | null
}

export interface RunInlineWorkflowInput {
  workspaceId: string
  source: string
  /** Synthetic path stamped into workflow_runs.script_path for display only;
   *  no file is read or written. Defaults to `<inline>` if omitted. */
  scriptPath?: string
  hivePort: string
  args?: unknown
  triggeredByAgentId?: string
}

/** TIER 2 #4 — narrow port the runner needs to clone a custom role
 *  into an ephemeral worker. Returns `undefined` if the name doesn't
 *  match any template (built-in or custom); the runner falls back to
 *  built-in-role semantics in that case. */
export type RoleTemplateResolver = WorkflowRoleTemplateResolver

const toNestedWorkflowFilename = (scriptName: string): string => {
  const trimmed = scriptName.trim()
  if (!trimmed) throw new Error('workflow(scriptName): scriptName must be a non-empty string')
  const filename = trimmed.toLowerCase().endsWith('.ts') ? trimmed : `${trimmed}.ts`
  assertWindowsSafeFilename(filename)
  return filename
}

/** TIER 2 #3 — narrator lane sink. The runner calls append(runId, message)
 *  every time the script invokes log(). Implementation lives in
 *  workflow-run-log-store; the port keeps the runner free of DB types. */
export interface WorkflowRunLogPort {
  append(runId: string, message: string, ts?: number): void
}

interface WorkflowRunStorePort {
  createRun: (input: {
    workspaceId: string
    scriptPath: string
    name: string
    scriptHash?: string
    args?: unknown
    parentRunId?: string | null
  }) => WorkflowRunRecord
  updateRun: (
    id: string,
    input: {
      status?: WorkflowRunStatus
      phase?: string
      finishedAt?: number
      error?: string
      result?: unknown
    }
  ) => void
  getRun: (id: string) => WorkflowRunRecord | undefined
  listChildRuns: (parentRunId: string) => WorkflowRunRecord[]
}

export interface WorkflowRunner {
  /** Runs the script to completion; returns the FINAL record. Used by tests
   *  and any caller that wants to wait synchronously. */
  runWorkflow: (input: RunWorkflowInput) => Promise<WorkflowRunRecord>
  /** Creates the run row + kicks off execution in the background; returns the
   *  INITIAL ('running') record. Used by the HTTP route so the response is
   *  fast — clients poll `getWorkflowRun(id)` for progress. */
  startWorkflow: (input: RunWorkflowInput) => Promise<WorkflowRunRecord>
  /** Like startWorkflow but takes raw source (no file). Used by `team workflow
   *  run --stdin/--inline` so the orchestrator can fire workflows from a PTY
   *  without writing a file first — matches Claude Code's Workflow tool
   *  invocation model. */
  startWorkflowInline: (input: RunInlineWorkflowInput) => Promise<WorkflowRunRecord>
  /** Cancel any in-flight `agent()` calls for `runId` (rejects their awaiters)
   *  and mark the next executeWorkflow catch as 'stopped' instead of 'failed'.
   *  Returns true if the run was running and got stopped, false otherwise. */
  stopRun: (runId: string) => boolean
  close: () => Promise<void>
}

interface ListDispatchesForStopPort {
  // Open dispatches whose fromAgentId === workflow pseudo-agent for the given
  // run. The runner pokes the awaiter so the in-flight agent() calls reject.
  listOpenDispatchIdsForRun: (runId: string) => string[]
  cancelOpenDispatchForRun: (workspaceId: string, dispatchId: string, reason: string) => boolean
}

export const createWorkflowRunner = (deps: {
  store: WorkflowAgentExecutorStorePort
  workflowRunStore: WorkflowRunStorePort
  awaiter: WorkflowDispatchAwaiter
  dispatchPort: ListDispatchesForStopPort
  /** Resolves the workspace's on-disk path. The nested `workflow(name)` DSL
   *  call needs it to locate sibling scripts when the parent run was fired
   *  inline via `team workflow run --stdin` (TIER 1 #7) — its scriptPath is
   *  a synthetic `<inline>` token that dirname() can't traverse. */
  resolveWorkspacePath: (workspaceId: string) => string
  /** TIER 2 #4 — used when agent() opts.agentType isn't a built-in role.
   *  The runner asks the resolver for a matching custom template; on hit
   *  the template's command + args replace the defaults, on miss the
   *  runner throws a clear error rather than silently spawning claude. */
  roleTemplateResolver: RoleTemplateResolver
  /** TIER 2 #3 — sink for the script's `log()` calls. The runner used
   *  to drop them on server stdout; routing through this port lets the
   *  Drawer render them as a narrator lane and the completion
   *  reminder splice the tail into the orchestrator's notification. */
  logStore: WorkflowRunLogPort
  /** Global workflow CLI policy (default + allowlist). Replaces the old
   *  hard-coded `claude` default: an `agent()` that omits `cli` now uses
   *  the user's configured default, and an explicit `cli` outside the
   *  allowlist fails the call with a clear, fixable error. */
  getWorkflowCliPolicy: () => WorkflowCliPolicy
  resolveCliLaunchConfig: (cli: string) => AgentLaunchConfigInput | undefined
  /** Called when a run reaches a terminal state (completed/failed/stopped).
   *  The runtime uses this to inject a `<hive-system-reminder>` into the
   *  triggering agent's PTY so the orchestrator picks the result back up,
   *  mirroring Claude Code's `<task-notification>` flow. */
  onRunFinished?: (input: {
    runId: string
    triggeredByAgentId: string
    finalRecord: WorkflowRunRecord
  }) => void
}): WorkflowRunner => {
  const {
    store,
    workflowRunStore,
    awaiter,
    dispatchPort,
    resolveWorkspacePath,
    roleTemplateResolver,
    logStore,
    resolveCliLaunchConfig,
    getWorkflowCliPolicy,
  } = deps
  let closing = false
  let closePromise: Promise<void> | undefined
  const operations = new Set<Promise<unknown>>()
  const executions = new Map<string, Promise<void>>()
  const hostCalls = new Set<Promise<void>>()
  const ownedScriptWorkers = new Set<WorkflowScriptWorker>()
  const assertAccepting = () => {
    if (closing) throw new Error('Workflow runner is closing')
  }
  const trackOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('Workflow runner is closing'))
    const promise = Promise.resolve().then(operation)
    operations.add(promise)
    void promise.then(
      () => operations.delete(promise),
      () => operations.delete(promise)
    )
    return promise
  }
  const stoppedRuns = new Set<string>()
  const abortedRuns = new Map<string, string>()
  const activeScriptWorkers = new Map<string, WorkflowScriptWorker>()
  const activeBudgets = new Map<string, WorkflowAgentBudget>()
  // In-memory map: runId → triggering agent. Lost on restart; the spec already
  // doesn't auto-resume interrupted runs, so this is consistent.
  const triggeringAgentByRun = new Map<string, string>()

  const isRunStopped = (runId: string) =>
    stoppedRuns.has(runId) || workflowRunStore.getRun(runId)?.status === 'stopped'

  const assertRunActive = (runId: string) => {
    const budget = activeBudgets.get(runId)
    if (budget) assertWorkflowBudgetActive(budget)
    if (isRunStopped(runId)) throw new Error('Stopped by user')
    const abortReason = abortedRuns.get(runId)
    if (abortReason) throw new Error(abortReason)
    const current = workflowRunStore.getRun(runId)
    if (current && current.status !== 'running') {
      throw new Error(current.error || `Workflow run is ${current.status}`)
    }
  }

  const cancelOpenDispatch = (workspaceId: string, dispatchId: string, reason: string) => {
    const cancelled = dispatchPort.cancelOpenDispatchForRun(workspaceId, dispatchId, reason)
    if (cancelled) awaiter.notifyCancel(dispatchId, reason)
  }

  const cancelOpenDispatchesForRun = (
    runId: string,
    workspaceId: string,
    reason: string
  ): string[] => {
    const errors: string[] = []
    for (const dispatchId of dispatchPort.listOpenDispatchIdsForRun(runId)) {
      try {
        cancelOpenDispatch(workspaceId, dispatchId, reason)
      } catch (error) {
        errors.push(errorToMessage(error))
        console.error('[hive] swallowed:workflow.cancelOpenDispatch', error)
      }
    }
    return errors
  }

  const appendTerminalRunError = (runId: string, message: string) => {
    const current = workflowRunStore.getRun(runId)
    if (!current || current.status === 'completed') return
    const nextError = current.error ? `${current.error}; ${message}` : message
    workflowRunStore.updateRun(runId, { error: nextError })
  }

  const executeWorkflow = async (
    run: WorkflowRunRecord,
    loaded: Awaited<ReturnType<typeof loadWorkflowScriptFile>>,
    args: unknown,
    hivePort: string
  ): Promise<void> => {
    const workspaceId = run.workspaceId
    const parentBudget = run.parentRunId ? activeBudgets.get(run.parentRunId) : undefined
    const budget = createWorkflowAgentBudget(
      {
        ...(typeof loaded.meta.maxAgentCalls === 'number'
          ? { maxAgentCalls: loaded.meta.maxAgentCalls }
          : {}),
      },
      parentBudget
    )
    if (run.parentRunId && !parentBudget)
      closeWorkflowAgentBudget(budget, 'Parent workflow is no longer active')
    activeBudgets.set(run.id, budget)
    let executorForCleanup: ReturnType<typeof createWorkflowAgentCallExecutor> | undefined
    let budgetTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const workflowAgentId = getWorkflowAgentId(workspaceId)
      // Read the CLI policy once per run so a 1000-way fan-out doesn't hit the
      // app_state table per agent() call.
      const cliPolicy = getWorkflowCliPolicy()
      let agentExecutor: ReturnType<typeof createWorkflowAgentCallExecutor>
      const dagLayerTracker = createWorkflowDagLayerTracker({
        awaiter,
        cancelQueuedAgentCallsForDagLayer: (layerId, reason) =>
          agentExecutor.cancelQueuedAgentCallsForDagLayer(layerId, reason),
        dispatchPort,
        workspaceId,
      })

      // TIER 2 #2 + #11 — runtime caps. Per-run agent ceiling, per-call
      // concurrency throttle, and a hard wall-clock budget. meta can
      // override the defaults per script. The budget timer arms here and
      // gets cleared in the finally branch so a fast-completing run
      // doesn't leave a dangling timer in the event loop.
      const maxDurationMs =
        typeof loaded.meta.maxDurationMs === 'number' && loaded.meta.maxDurationMs > 0
          ? loaded.meta.maxDurationMs
          : DEFAULT_MAX_DURATION_MS

      // R1/R2 auto-rounding: a phase('Find') called twice in the same run gets
      // rendered as "Find" then "Find R2" etc. Mirrors Claude Code's /workflows
      // view — keeps the UI readable when a workflow loops phases.
      const phaseEntryCount = new Map<string, number>()
      let currentPhaseTitle: string | null = null

      const phase = (title: string) => {
        const trimmed = (title ?? '').toString().trim() || 'default'
        const next = (phaseEntryCount.get(trimmed) ?? 0) + 1
        phaseEntryCount.set(trimmed, next)
        currentPhaseTitle = next > 1 ? `${trimmed} R${next}` : trimmed
        workflowRunStore.updateRun(run.id, { phase: currentPhaseTitle })
      }

      agentExecutor = createWorkflowAgentCallExecutor({
        budget,
        assertRunActive: () => assertRunActive(run.id),
        awaiter,
        cancelOpenDispatch: (dispatchId, reason) =>
          cancelOpenDispatch(workspaceId, dispatchId, reason),
        cliPolicy,
        getCurrentPhaseTitle: () => currentPhaseTitle,
        hivePort,
        isRunStopped: () => isRunStopped(run.id),
        ...(typeof loaded.meta.maxAgentCalls === 'number'
          ? { maxAgentCalls: loaded.meta.maxAgentCalls }
          : {}),
        registerDagDispatch: dagLayerTracker.registerDispatch,
        resolveCliLaunchConfig,
        roleTemplateResolver,
        runId: run.id,
        store,
        workflowAgentId,
        workflowName: loaded.meta.name,
        workspaceId,
        workspacePath: resolveWorkspacePath(workspaceId),
      })
      executorForCleanup = agentExecutor
      const cancelDagLayerAgents = dagLayerTracker.cancelLayerAgents
      const log = (message: string) => {
        assertRunActive(run.id)
        // TIER 2 #3 — persist + still echo to stdout for server-log
        // visibility. Authors expect `log()` to surface in the Drawer's
        // narrator lane and in the orchestrator's completion reminder.
        // The console.log retains the server-side breadcrumb for ops.
        const text = typeof message === 'string' ? message : String(message)
        try {
          logStore.append(run.id, text)
        } catch (error) {
          console.error('[hive] swallowed:workflow.log.append', error)
        }
        console.log(`[workflow ${loaded.meta.name}] ${text}`)
      }

      // Nested workflow: look up a sibling script in the same .hive/workflows/
      // directory and run it through THIS runner instance. The child run gets
      // its own row in workflow_runs and shares the dispatch-await machinery
      // (so its `agent()` calls work the same way the parent's do).
      //
      // TIER 1 #7 — when the parent was fired inline (`team workflow run
      // --stdin`), its scriptPath is the synthetic token `<inline>` /
      // `<inline:name>`. `dirname('<inline>')` collapses to `.` and the
      // child would resolve against the runtime's CWD — wrong directory,
      // reliably broken. Detect the synthetic prefix and fall back to the
      // workspace's `.hive/workflows/` directory, which is the canonical
      // sibling-script location.
      const isSyntheticParentPath = run.scriptPath.startsWith('<inline')
      const workflow = async (
        scriptName: string,
        childArgs?: unknown
      ): Promise<WorkflowRunRecord> => {
        assertRunActive(run.id)
        if (typeof scriptName !== 'string' || !scriptName.trim()) {
          throw new Error('workflow(scriptName): scriptName must be a non-empty string')
        }
        const filename = toNestedWorkflowFilename(scriptName)
        const childPath = isSyntheticParentPath
          ? join(resolveWorkspacePath(workspaceId), '.hive', 'workflows', filename)
          : join(dirname(run.scriptPath), filename)
        const child = await runWorkflow({
          workspaceId,
          scriptPath: childPath,
          hivePort,
          // TIER 2 #5 — stamp the parent run id so the UI can render the
          // nested workflow tree.
          parentRunId: run.id,
          ...(childArgs !== undefined ? { args: childArgs } : {}),
        })
        assertRunActive(run.id)
        return child
      }

      const runScriptWorker = (): Promise<unknown> =>
        runWorkflowScriptWorker<WorkflowAgentOptions>({
          args,
          compiledFunctionSource: loaded.compiledFunctionSource,
          scriptPath: loaded.scriptPath,
          workerSource: WORKFLOW_VM_WORKER_URL,
          onWorkerCreated: (worker) => {
            activeScriptWorkers.set(run.id, worker)
            ownedScriptWorkers.add(worker)
            worker.once('exit', () => ownedScriptWorkers.delete(worker))
          },
          onHostCallStarted: (call) => {
            hostCalls.add(call)
            void call.then(
              () => hostCalls.delete(call),
              () => hostCalls.delete(call)
            )
          },
          onWorkerSettled: () => activeScriptWorkers.delete(run.id),
          handlers: {
            agent: agentExecutor.agent,
            phase,
            log,
            workflow,
            catchPerItem: agentExecutor.catchPerItem,
            cancelDagLayerAgents,
            assertRunActive: () => assertRunActive(run.id),
          },
        })

      // TIER 2 #11 — wall-clock budget timer. Triggers stopRun on
      // expiry, which routes through the same path as a user-initiated
      // stop (in-flight awaiters reject; outer catch records 'stopped').
      // The setTimeout is unref'd so a forgotten timer can't keep the
      // Node process alive after shutdown. stopRun is declared further
      // down the file but exists by the time this timer fires, so the
      // closure reference is safe.
      budgetTimer = setTimeout(() => {
        log(`[hive] maxDurationMs (${maxDurationMs}ms) exceeded — stopping run`)
        stopRun(run.id)
      }, maxDurationMs)
      budgetTimer.unref?.()

      assertRunActive(run.id)
      const returnValue = await runScriptWorker()
      const abortReason = abortedRuns.get(run.id)
      if (abortReason) {
        throw new Error(abortReason)
      }
      // TIER 1 #2 — if stop was called DURING the run, parallel/pipeline may
      // have caught the cancel rejections (one per in-flight thunk) before
      // the per-item catch could re-throw, e.g. when the user stops AFTER
      // the inner Promise.all has already started but BEFORE any thunk
      // rejects. In that race we'd otherwise write 'completed' with a
      // degraded result (often a list of nulls), which both lies to the UI
      // and lies to the orchestrator's completion notification. Check the
      // marker after fn returns and record the truth instead.
      if (stoppedRuns.has(run.id) || workflowRunStore.getRun(run.id)?.status === 'stopped') {
        workflowRunStore.updateRun(run.id, {
          status: 'stopped',
          finishedAt: Date.now(),
          error: 'Stopped by user',
        })
      } else {
        // M10: capture the script's return value so the UI can render a single
        // canonical "Result" panel and the orchestrator notification can quote
        // it. `undefined` (no explicit return) stays null on the row.
        workflowRunStore.updateRun(run.id, {
          status: 'completed',
          finishedAt: Date.now(),
          ...(returnValue !== undefined ? { result: returnValue } : {}),
        })
      }
    } catch (error) {
      if (stoppedRuns.has(run.id)) {
        return
      }
      const wasStopped = workflowRunStore.getRun(run.id)?.status === 'stopped'
      if (wasStopped) return
      const message = errorToMessage(error)
      abortedRuns.set(run.id, message)
      workflowRunStore.updateRun(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: message,
      })
    } finally {
      try {
        clearTimeout(budgetTimer)
        const finalRecord = workflowRunStore.getRun(run.id)
        let terminalCleanup = false
        if (finalRecord && finalRecord.status !== 'completed') {
          terminalCleanup = true
          const cleanupReason =
            finalRecord.error || abortedRuns.get(run.id) || 'Workflow run stopped'
          closeWorkflowAgentBudget(budget, cleanupReason)
          for (const child of workflowRunStore.listChildRuns(run.id)) {
            stopRunAndChildren(child.id, new Set([run.id]))
          }
          executorForCleanup?.forceCancelActiveDispatchWaiters(cleanupReason)
          const cancelErrors = cancelOpenDispatchesForRun(
            run.id,
            finalRecord.workspaceId,
            cleanupReason
          )
          if (cancelErrors.length > 0) {
            appendTerminalRunError(
              run.id,
              `cleanup failed to cancel ${cancelErrors.length} workflow dispatch${
                cancelErrors.length === 1 ? '' : 'es'
              }: ${cancelErrors.join('; ')}`
            )
          }
        }
        const activeCalls = await executorForCleanup?.waitForActiveCalls(
          terminalCleanup ? ACTIVE_AGENT_CALL_CLEANUP_TIMEOUT_MS : undefined
        )
        if (activeCalls && !activeCalls.settled) {
          const message = `cleanup timed out after ${ACTIVE_AGENT_CALL_CLEANUP_TIMEOUT_MS}ms waiting for ${activeCalls.activeCount} active workflow agent call${
            activeCalls.activeCount === 1 ? '' : 's'
          } to settle`
          console.error(`[hive] workflow.${message}`)
          appendTerminalRunError(run.id, message)
          executorForCleanup?.forceCancelActiveDispatchWaiters(message)
          await executorForCleanup?.waitForActiveCalls(1000)
        }
        // Belt-and-suspenders: dismiss any ephemeral worker still alive. The
        // per-call try/finally should already have cleaned each one up; this is
        // an idempotent safety net for unexpected paths.
        executorForCleanup?.deleteSpawnedWorkers()
        // Notify the triggering agent (orchestrator) that the run reached a
        // terminal state. Mirrors Claude Code's <task-notification> envelope.
        const triggeredByAgentId = triggeringAgentByRun.get(run.id)
        triggeringAgentByRun.delete(run.id)
        if (triggeredByAgentId && deps.onRunFinished) {
          const finalRecord = workflowRunStore.getRun(run.id)
          if (finalRecord) {
            try {
              deps.onRunFinished({ runId: run.id, triggeredByAgentId, finalRecord })
            } catch (error) {
              console.error('[hive] swallowed:workflow.onRunFinished', error)
            }
          }
        }
      } finally {
        closeWorkflowAgentBudget(budget, 'Workflow run finished')
        activeBudgets.delete(run.id)
        stoppedRuns.delete(run.id)
        abortedRuns.delete(run.id)
        triggeringAgentByRun.delete(run.id)
      }
    }
  }

  const buildCreateInput = (
    input: RunWorkflowInput,
    loaded: Awaited<ReturnType<typeof loadWorkflowScriptFile>>
  ): Parameters<typeof workflowRunStore.createRun>[0] => {
    const createInput: Parameters<typeof workflowRunStore.createRun>[0] = {
      workspaceId: input.workspaceId,
      scriptPath: input.scriptPath,
      name: loaded.meta.name,
      scriptHash: loaded.scriptHash,
    }
    if (input.args !== undefined) createInput.args = input.args
    if (input.parentRunId !== undefined) createInput.parentRunId = input.parentRunId
    return createInput
  }

  const rememberTrigger = (runId: string, triggeredByAgentId: string | undefined) => {
    if (triggeredByAgentId) triggeringAgentByRun.set(runId, triggeredByAgentId)
  }

  const assertParentRunStillRunning = (
    input: Pick<RunWorkflowInput, 'parentRunId' | 'workspaceId'>
  ) => {
    if (!input.parentRunId) return
    const parent = workflowRunStore.getRun(input.parentRunId)
    if (
      !parent ||
      parent.workspaceId !== input.workspaceId ||
      parent.status !== 'running' ||
      !activeBudgets.has(input.parentRunId)
    ) {
      throw new Error('Parent workflow is no longer active')
    }
    assertRunActive(input.parentRunId)
  }

  const startExecution = (
    run: WorkflowRunRecord,
    loaded: Awaited<ReturnType<typeof loadWorkflowScriptFile>>,
    input: Pick<RunWorkflowInput, 'args' | 'hivePort'>
  ): Promise<void> => {
    const execution = Promise.resolve().then(async () => {
      if (closing) {
        stopRun(run.id)
        triggeringAgentByRun.delete(run.id)
        return
      }
      await executeWorkflow(run, loaded, input.args, input.hivePort)
    })
    executions.set(run.id, execution)
    void execution.then(
      () => executions.delete(run.id),
      () => executions.delete(run.id)
    )
    return execution
  }

  const runWorkflow = (input: RunWorkflowInput): Promise<WorkflowRunRecord> =>
    trackOperation(async () => {
      assertAccepting()
      const loaded = await loadWorkflowScriptFile(input.scriptPath)
      assertAccepting()
      assertParentRunStillRunning(input)
      const run = workflowRunStore.createRun(buildCreateInput(input, loaded))
      rememberTrigger(run.id, input.triggeredByAgentId)
      await startExecution(run, loaded, input)
      const finalized = workflowRunStore.getRun(run.id)
      if (!finalized) throw new Error(`workflow run vanished mid-flight: ${run.id}`)
      return finalized
    })

  const startWorkflow = (input: RunWorkflowInput): Promise<WorkflowRunRecord> =>
    trackOperation(async () => {
      assertAccepting()
      const loaded = await loadWorkflowScriptFile(input.scriptPath)
      assertAccepting()
      assertParentRunStillRunning(input)
      const run = workflowRunStore.createRun(buildCreateInput(input, loaded))
      rememberTrigger(run.id, input.triggeredByAgentId)
      void startExecution(run, loaded, input).catch((error) => {
        console.error('[hive] swallowed:workflow.background', error)
      })
      return run
    })

  const startWorkflowInline = (input: RunInlineWorkflowInput): Promise<WorkflowRunRecord> =>
    trackOperation(async () => {
      assertAccepting()
      const scriptPath = input.scriptPath ?? '<inline>'
      const loaded = await loadWorkflowScriptSource(input.source, scriptPath)
      assertAccepting()
      const run = workflowRunStore.createRun(
        buildCreateInput({ ...input, scriptPath } as RunWorkflowInput, loaded)
      )
      rememberTrigger(run.id, input.triggeredByAgentId)
      void startExecution(run, loaded, input).catch((error) => {
        console.error('[hive] swallowed:workflow.background', error)
      })
      return run
    })

  const stopRunAndChildren = (runId: string, visited: Set<string>): boolean => {
    if (visited.has(runId)) return false
    visited.add(runId)
    const current = workflowRunStore.getRun(runId)
    if (!current) return false
    const budget = activeBudgets.get(runId)
    if (budget) closeWorkflowAgentBudget(budget, 'Stopped by user')
    for (const child of workflowRunStore.listChildRuns(runId)) {
      stopRunAndChildren(child.id, visited)
    }
    if (current.status !== 'running') return false
    stoppedRuns.add(runId)
    void activeScriptWorkers
      .get(runId)
      ?.terminate()
      .catch(() => {})
    // Cancel every open workflow dispatch tied to this run; this rejects the
    // runner's pending `awaitReport` promises, which propagates up the
    // executeWorkflow try → its catch sets status='stopped'.
    cancelOpenDispatchesForRun(runId, current.workspaceId, 'Stopped by user')
    workflowRunStore.updateRun(runId, {
      status: 'stopped',
      finishedAt: Date.now(),
      error: 'Stopped by user',
    })
    // If the script had no in-flight agent() call when stop was requested,
    // it may never reject on its own. Persist the stopped state immediately
    // so UI/API truth does not depend on the script reaching a later awaiter.
    return true
  }

  const stopRun = (runId: string): boolean => stopRunAndChildren(runId, new Set())

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      for (const runId of executions.keys()) stopRun(runId)
      const pendingExecutions = [...executions.values()]
      const workers = [...ownedScriptWorkers].map((worker) => worker.terminate())
      // Admissions are closed before this snapshot. Pending loads can only
      // reject; callers and host calls finish while their stores remain open.
      const results = await Promise.allSettled([
        ...pendingExecutions,
        ...workers,
        Promise.allSettled(operations),
      ])
      await Promise.allSettled(hostCalls)
      const errors = results.filter((result) => result.status === 'rejected')
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          'Workflow shutdown failed'
        )
    })()
    return closePromise
  }

  return { runWorkflow, startWorkflow, startWorkflowInline, stopRun, close }
}
