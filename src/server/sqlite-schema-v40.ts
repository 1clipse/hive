import type { Database } from './sqlite.js'

/** v40: remove the retired Sentinel role/template and any stale Sentinel workers. */
export const applySchemaVersion40 = (db: Database) => {
  const hasRoleTemplates = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
    .get()
  const deleteSentinelTemplate = hasRoleTemplates
    ? db.prepare("DELETE FROM role_templates WHERE id = 'sentinel' OR role_type = 'sentinel'")
    : null

  const hasWorkers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workers'")
    .get()
  if (!hasWorkers) {
    deleteSentinelTemplate?.run()
    return
  }

  const rows = db.prepare("SELECT workspace_id, id FROM workers WHERE role = 'sentinel'").all() as
    | Array<{ id: string; workspace_id: string }>
    | []
  const deleteMessages = db.prepare(
    `DELETE FROM messages
     WHERE workspace_id = ?
       AND (worker_id = ? OR from_agent_id = ? OR to_agent_id = ?)`
  )
  const deleteReportOutbox = db.prepare(
    `DELETE FROM report_outbox
     WHERE workspace_id = ?
       AND (
         target_agent_id = ?
         OR dispatch_id IN (
           SELECT id FROM dispatches
           WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)
         )
       )`
  )
  const deleteDispatches = db.prepare(
    'DELETE FROM dispatches WHERE workspace_id = ? AND (from_agent_id = ? OR to_agent_id = ?)'
  )
  const deleteLaunch = db.prepare(
    'DELETE FROM agent_launch_configs WHERE workspace_id = ? AND agent_id = ?'
  )
  const deleteSessions = db.prepare(
    'DELETE FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
  )
  const deleteRuns = db.prepare('DELETE FROM agent_runs WHERE agent_id = ?')
  const deleteWorker = db.prepare('DELETE FROM workers WHERE workspace_id = ? AND id = ?')

  db.transaction(() => {
    deleteSentinelTemplate?.run()
    for (const row of rows) {
      deleteMessages.run(row.workspace_id, row.id, row.id, row.id)
      deleteReportOutbox.run(row.workspace_id, row.id, row.workspace_id, row.id, row.id)
      deleteDispatches.run(row.workspace_id, row.id, row.id)
      deleteLaunch.run(row.workspace_id, row.id)
      deleteSessions.run(row.workspace_id, row.id)
      deleteRuns.run(row.id)
      deleteWorker.run(row.workspace_id, row.id)
    }
  })()
}
