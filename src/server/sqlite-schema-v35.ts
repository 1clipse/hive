import {
  CODER_ROLE_DESCRIPTION,
  ORCHESTRATOR_ROLE_DESCRIPTION,
  REVIEWER_ROLE_DESCRIPTION,
  TESTER_ROLE_DESCRIPTION,
} from './role-templates.js'
import type { Database } from './sqlite.js'

const BUILTIN_ROLE_DESCRIPTIONS = [
  ['orchestrator', ORCHESTRATOR_ROLE_DESCRIPTION],
  ['coder', CODER_ROLE_DESCRIPTION],
  ['reviewer', REVIEWER_ROLE_DESCRIPTION],
  ['tester', TESTER_ROLE_DESCRIPTION],
] as const

/** v35: refresh built-in role contracts to be English-first bilingual prompts. */
export const applySchemaVersion35 = (db: Database) => {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
    .get()
  if (!table) return

  const now = Date.now()
  const updateTemplate = db.prepare(
    `UPDATE role_templates
     SET description = ?, updated_at = ?
     WHERE id = ? AND is_builtin = 1`
  )
  for (const [id, description] of BUILTIN_ROLE_DESCRIPTIONS) {
    updateTemplate.run(description, now, id)
  }
}
