import type { Database } from './sqlite.js'

const HERMES_SESSION_ID_CAPTURE = {
  pattern: String.raw`Session:\s*([A-Za-z0-9_-]+)`,
  source: 'stdout_regex',
}

const HERMES_YOLO_ARGS = ['--yolo']

export const applySchemaVersion22 = (db: Database) => {
  const hasCommandPresets = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'command_presets'")
    .get()
  if (!hasCommandPresets) return
  const now = Date.now()
  db.prepare(
    `INSERT INTO command_presets (
       id, display_name, command, args, env, resume_args_template, session_id_capture,
       yolo_args_template, is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       command = excluded.command,
       args = excluded.args,
       env = excluded.env,
       resume_args_template = excluded.resume_args_template,
       session_id_capture = excluded.session_id_capture,
       yolo_args_template = excluded.yolo_args_template,
       updated_at = excluded.updated_at
    WHERE command_presets.is_builtin = 1`
  ).run(
    'hermes',
    'Hermes',
    'hermes',
    '[]',
    '{}',
    '--resume {session_id}',
    JSON.stringify(HERMES_SESSION_ID_CAPTURE),
    JSON.stringify(HERMES_YOLO_ARGS),
    now,
    now
  )
}
