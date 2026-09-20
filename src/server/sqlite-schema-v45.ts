import type { Database } from './sqlite.js'

/** Optional per-agent launch cwd (workflow worktree isolation). */
export const applySchemaVersion45 = (db: Database) => {
  const present = new Set(
    (db.prepare('PRAGMA table_info(agent_launch_configs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!present.has('cwd')) {
    db.exec('ALTER TABLE agent_launch_configs ADD COLUMN cwd TEXT')
  }
}
