import { randomUUID } from 'node:crypto'
import { isWorkerRole, type WorkerRole } from '../shared/types.js'
import type { UiLanguage } from '../shared/ui-language.js'
import { BadRequestError } from './http-errors.js'

/**
 * Role + name defaults for `team spawn` (routes-team /api/team/spawn).
 *
 * The natural orchestrator flow is `team spawn researcher` followed by
 * `team send researcher "..."` — `team send` matches the worker NAME
 * exactly, so the spawn defaults must keep that flow working:
 *
 * - When `--name` is omitted, the worker is named after the requested role
 *   label verbatim (`researcher`), as long as that name is free. Only on a
 *   roster collision do we fall back to the old `<label>-<uuid>` form —
 *   the spawn response echoes the final name either way.
 * - A role label outside the built-in set maps to 'custom' (NOT 'coder':
 *   silently relabeling `researcher` as a coder hid the coercion from the
 *   orchestrator and broke send-by-role). The requested label survives in
 *   the worker name and in a generated role description.
 */
const REMOVED_ROLE_LABELS = new Set(['sentinel'])

/* The built-in pseudo-agents ('Orchestrator' / 'Workflow') are not workers,
   so the store's duplicate-name check can't protect them. Don't let a bare
   `team spawn orchestrator` mint a second roster entry that reads like the
   queen — those labels take the uuid fallback instead. */
const RESERVED_BARE_NAMES = new Set(['orchestrator', 'workflow'])

/* workspace-store normalizeWorkerName caps names at 64 chars; keep room for
   the '-' + uuid (37 chars) so the fallback never trips that limit. */
const MAX_NAME_LENGTH = 64
const MAX_LABEL_IN_FALLBACK = MAX_NAME_LENGTH - 37

export interface SpawnWorkerDefaults {
  role: WorkerRole
  name: string
  /** Present only when an unknown role label was mapped to 'custom' — keeps
      the requested label visible instead of the generic custom placeholder. */
  description?: string
}

export const resolveSpawnWorkerDefaults = (input: {
  language?: UiLanguage
  requestedRole: string | undefined
  requestedName: string | undefined
  takenNames: ReadonlySet<string>
}): SpawnWorkerDefaults => {
  const label = input.requestedRole?.trim() || 'coder'
  if (REMOVED_ROLE_LABELS.has(label.toLowerCase())) {
    throw new BadRequestError(
      "Role 'sentinel' was removed; use coder, reviewer, tester, or custom."
    )
  }
  const role = isWorkerRole(label) ? label : 'custom'
  const language = input.language ?? 'en'
  const description =
    role === 'custom' && label !== 'custom'
      ? language === 'zh'
        ? [
            `你是 ${label}，按 Orchestrator 派发的任务说明工作。`,
            '完成后用 `team report` 汇报结果、风险和阻塞。',
          ].join('\n')
        : [
            `You are ${label}. Work from the task instructions dispatched by the Orchestrator.`,
            'When done, use `team report` to report results, risks, and blockers.',
          ].join('\n')
      : undefined

  const requestedName = input.requestedName?.trim()
  const bareLabelAvailable =
    label.length <= MAX_NAME_LENGTH &&
    !RESERVED_BARE_NAMES.has(label.toLowerCase()) &&
    !input.takenNames.has(label)
  const name =
    requestedName ||
    (bareLabelAvailable ? label : `${label.slice(0, MAX_LABEL_IN_FALLBACK)}-${randomUUID()}`)

  return description === undefined ? { role, name } : { role, name, description }
}
