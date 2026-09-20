import type { Database } from './sqlite.js'

export interface WorkflowRunLogRecord {
  id: number
  runId: string
  ts: number
  message: string
}

/* TIER 2 #3 — narrator lane storage. `log()` calls from a workflow script
 * append here; the Drawer polls listForRun(runId) alongside the dispatch
 * timeline; the orchestrator's completion reminder splices in the last
 * few lines so a run that finished with a long sequence of `log()` calls
 * can be summarised back to the user.
 *
 * Append-only. No retention policy yet — TIER 3 work if log volume grows
 * to where it matters; CC's Workflow tool keeps logs for the run's
 * lifetime so we mirror that. */
export const createWorkflowRunLogStore = (db: Database) => {
  const insert = db.prepare('INSERT INTO workflow_run_logs (run_id, ts, message) VALUES (?, ?, ?)')
  const listStmt = db.prepare(
    'SELECT id, run_id, ts, message FROM workflow_run_logs WHERE run_id = ? ORDER BY id'
  )
  const tailStmt = db.prepare(
    'SELECT message FROM workflow_run_logs WHERE run_id = ? ORDER BY id DESC LIMIT ?'
  )
  const deleteForRunStmt = db.prepare('DELETE FROM workflow_run_logs WHERE run_id = ?')
  const deleteForWorkspaceStmt = db.prepare(
    `DELETE FROM workflow_run_logs
     WHERE run_id IN (SELECT id FROM workflow_runs WHERE workspace_id = ?)`
  )

  return {
    append(runId: string, message: string, ts: number = Date.now()): void {
      insert.run(runId, ts, message)
    },
    listForRun(runId: string): WorkflowRunLogRecord[] {
      return (
        listStmt.all(runId) as Array<{
          id: number
          run_id: string
          ts: number
          message: string
        }>
      ).map((row) => ({
        id: row.id,
        runId: row.run_id,
        ts: row.ts,
        message: row.message,
      }))
    },
    /** Last `n` log messages for the run, oldest-first. Used by the
     *  onRunFinished reminder to include a short narrator tail in the
     *  orchestrator's completion notification without overwhelming it. */
    tailForRun(runId: string, n: number): string[] {
      const rows = tailStmt.all(runId, n) as Array<{ message: string }>
      return rows.map((r) => r.message).reverse()
    },
    deleteForRun(runId: string): void {
      deleteForRunStmt.run(runId)
    },
    /** Cascade hook: deleted alongside workflow_runs when a workspace
     *  is removed (TIER 1 #4 cascade). */
    deleteForWorkspace(workspaceId: string): void {
      deleteForWorkspaceStmt.run(workspaceId)
    },
  }
}
