import { randomBytes } from 'node:crypto'
import { generateWorkerName } from '../shared/random-worker-name.js'
import type { ScenarioWorkerSpec } from '../shared/scenario-presets.js'
import type { WorkerRole } from '../shared/types.js'
import type { UiLanguage } from '../shared/ui-language.js'

export {
  getScenarioPreset,
  getScenarioWorkerDescription,
  SCENARIO_PRESETS,
  type ScenarioId,
  type ScenarioPreset,
  type ScenarioWorkerSpec,
} from '../shared/scenario-presets.js'

/**
 * Scenario member names come from the same agent-name-bank pool the Add
 * Member dialog uses. When every bank name is already taken in a busy
 * workspace, append a short suffix instead of failing the whole scenario.
 */
export const buildScenarioWorkerName = (
  spec: Pick<ScenarioWorkerSpec, 'nameStem' | 'role'>,
  usedNames: ReadonlySet<string>,
  input: { nextUint32?: () => number } = {},
  maxAttempts = 16
): string => {
  const candidate = generateWorkerName({
    usedNames,
    ...(input.nextUint32 !== undefined ? { nextUint32: input.nextUint32 } : {}),
  })
  if (!usedNames.has(candidate)) return candidate

  const base = candidate || spec.nameStem
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4)
    const name = `${base}-${suffix}`
    if (!usedNames.has(name)) return name
  }
  throw new Error(`Could not generate a unique member name for: ${spec.nameStem}`)
}

export interface ScenarioKickoffInput {
  scenarioId: string
  goal: string
  language?: UiLanguage
  workers: Array<{ name: string; role: WorkerRole }>
}

/**
 * The user-visible kickoff message injected into the orchestrator's stdin via
 * `recordUserInput` after a scenario team is assembled. It only states facts
 * (scenario, roster, goal) and asks the orchestrator to plan and dispatch —
 * the dispatch decisions themselves stay with the orchestrator (we never call
 * dispatch on its behalf).
 */
export const buildScenarioKickoffMessage = (input: ScenarioKickoffInput): string => {
  const roster = input.workers.map((worker) => `- ${worker.name} (${worker.role})`).join('\n')
  if (input.language === 'zh') {
    return [
      `用户选择了 "${input.scenarioId}" 场景，Hive 已经为你创建这些团队成员：`,
      roster,
      '',
      '用户目标：',
      input.goal,
      '',
      '请先运行 `team list` 确认团队成员，然后把目标拆成任务，并用 `team send "<member-name>" "<task>"` 派发。任务拆分由你决定；只有缺少真实决策时才回问用户。',
    ].join('\n')
  }
  return [
    `The user picked the "${input.scenarioId}" scenario and Hive has already created these team members for you:`,
    roster,
    '',
    'Goal from the user:',
    input.goal,
    '',
    'Break the goal into tasks and dispatch them with `team send "<member-name>" "<task>"` — run `team list` first to confirm current members. Plan the split yourself; only come back to the user for genuinely missing decisions.',
  ].join('\n')
}
