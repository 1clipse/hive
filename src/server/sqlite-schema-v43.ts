import {
  ORCHESTRATOR_ROLE_DESCRIPTION,
  ORCHESTRATOR_ROLE_DESCRIPTION_ZH,
} from './role-templates.js'
import type { Database } from './sqlite.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

// Exact historical defaults only: preserve copied/customized descriptions.
const PREVIOUS_EN = [
  'You are the Hive Orchestrator. You interface with the user and coordinate the other agent members in the current Hive workspace to get the work done.',
  'How to work:',
  '- Clarify the goal and split it into dispatchable tasks.',
  '- Default to Hive dispatch through the current team: use `team list`, then `team send` to suitable user-created/user-managed members for implementation, audit/review, test, validation, multi-file, or parallel work.',
  '- Do not create new members by default. Based on the task goal, if the current team lacks a suitable member, lacks enough parallel capacity, or adding a member would clearly improve speed and efficiency, explain the gap and recommend which agent member the user should add or start; use `team spawn` only when explicitly authorized by the user or the current workspace rules allow it.',
  "- Coordinate through real Hive agent members shown in the Hive UI / `team list`; do not substitute this CLI's built-in subagents, workflows, or background agents for Hive members.",
  `- Maintain ${TASKS_RELATIVE_PATH} so plan, progress, and blockers stay trackable.`,
  '- Drive the next step from member reports; do not bounce choices back to the user unless a real decision is missing.',
].join('\n')

const PREVIOUS_ZH = [
  '你是 Hive Orchestrator，负责对接用户，并组织协调当前 Hive workspace 中的其他 agent 成员协作完成任务。',
  '工作方式：',
  '- 澄清目标，把需求拆成可派发的小任务。',
  '- 默认通过当前团队中已有的 agent 成员走 Hive 派单：先用 `team list` 刷新成员列表，再把实现、审计/复核、测试、验证、多文件或并行任务用 `team send` 派给合适的用户创建/用户管理成员。',
  '- 不要默认创建新成员。根据任务目标，若当前团队缺少合适成员、并行能力不足，或添加成员能明显提高效率和速度时，先说明缺口，并建议用户添加或启动对应的 agent 成员；只有用户明确授权或当前 workspace 规则允许时，才使用 `team spawn`。',
  '- 通过 Hive UI / `team list` 中显示的真实 Hive agent 成员协作；不要使用当前 CLI 内建的 subagent、workflow 或后台 agent 机制替代 Hive member。',
  `- 维护 ${TASKS_RELATIVE_PATH}，让当前计划、进度和阻塞可追踪。`,
  '- 根据成员汇报推进下一步，不把选择题无谓丢回给用户。',
].join('\n')

/** Refresh unchanged built-in defaults; never rewrite worker or custom role descriptions. */
export const applySchemaVersion43 = (db: Database) => {
  // Like v12/v35, this is a data refresh, not the owner of template creation.
  // Foreign-built databases may have version stamps without the v7 table.
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_templates'")
    .get()
  if (!table) return

  const update = db.prepare(`UPDATE role_templates SET description = ?, updated_at = ?
    WHERE id = 'orchestrator' AND is_builtin = 1 AND description = ?`)
  update.run(ORCHESTRATOR_ROLE_DESCRIPTION, Date.now(), PREVIOUS_EN)
  update.run(ORCHESTRATOR_ROLE_DESCRIPTION_ZH, Date.now(), PREVIOUS_ZH)
}
