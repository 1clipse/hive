import type { WorkerRole } from './types.js'
import type { UiLanguage } from './ui-language.js'

/**
 * Scenario team presets — the data behind "one-click team assembly".
 *
 * Lives in `src/shared/` (same pattern as `open-targets.ts`) because both
 * sides consume it as a value import: the server route materializes the
 * workers, the web UI renders the cards and prefills the goal template.
 * Everything here is pure data — no node imports, safe to bundle.
 */

export type ScenarioId = 'build_review_test' | 'research_factcheck' | 'docs_pipeline'

export interface ScenarioWorkerSpec {
  /** Fallback stem if every bank name is taken and a unique `-<suffix>` must be appended. */
  nameStem: string
  role: WorkerRole
  /**
   * Role contract for `custom` workers, injected as the worker description
   * (startup prompt + every dispatch). Built-in roles omit this and fall back
   * to their default description from `role-templates.ts`.
   */
  descriptionOverride?: { en: string; zh: string }
}

export interface ScenarioPreset {
  id: ScenarioId
  workers: ScenarioWorkerSpec[]
  /** Placeholder goal the UI prefills for the user to edit before applying. */
  goalTemplate: { en: string; zh: string }
}

const RESEARCHER_DESCRIPTION_EN = [
  'You are a Researcher. Collect facts, data, and sources for the assigned topic.',
  'How to work:',
  '- Break the topic into key questions first, then investigate each one.',
  '- Prefer primary sources and real project files; attach a source or file path to every conclusion.',
  '- Separate facts, inferences, and unknowns; never present guesses as facts.',
  'Delivery: include findings by topic, source list, and unresolved questions.',
].join('\n')

const RESEARCHER_DESCRIPTION_ZH = [
  '你是 Researcher，负责为指定主题收集事实、数据和来源。',
  '工作方式：',
  '- 先拆出要回答的关键问题，再逐项调查。',
  '- 优先一手来源和项目内真实文件；每个结论都附上来源或文件路径。',
  '- 区分事实、推断和未知，不把猜测写成结论。',
  '交付说明：按主题列出发现、来源清单和未解决问题。',
].join('\n')

const FACTCHECKER_DESCRIPTION_EN = [
  'You are a Fact-checker. Verify research claims and evidence strength without expanding the scope by default.',
  'How to work:',
  '- Check every claim against its source and mark supported, uncertain, or unsupported.',
  '- Cross-check critical claims with a second source, command, or direct file read.',
  '- When a claim is wrong, provide the corrected wording and evidence.',
  'Delivery: group by confidence and list refuted or uncertain claims first.',
].join('\n')

const FACTCHECKER_DESCRIPTION_ZH = [
  '你是 Fact-checker，负责验证研究结论和证据强度，默认不扩范围。',
  '工作方式：',
  '- 逐条核对结论与其来源，标注支持、存疑或不支持。',
  '- 对关键结论用第二来源、命令或直接读文件做交叉验证。',
  '- 发现错误时给出纠正后的表述和依据。',
  '交付说明：按可信度分组，先列被推翻或存疑的结论。',
].join('\n')

const DRAFTER_DESCRIPTION_EN = [
  'You are a Drafter. Turn goals and source material into a clear first-draft document.',
  'How to work:',
  '- Confirm audience, purpose, and scope before outlining and writing.',
  '- Use real project code and files as the source of truth; do not invent behavior or APIs.',
  '- Mark missing material and points that need confirmation.',
  'Delivery: include document path, structure overview, and confirmation checklist.',
].join('\n')

const DRAFTER_DESCRIPTION_ZH = [
  '你是 Drafter，负责把目标和素材写成清晰的第一版文档。',
  '工作方式：',
  '- 先确认读者、目的和范围，再列提纲，后成文。',
  '- 以项目内真实代码和文件为准，不编造行为或接口。',
  '- 标注待确认和缺素材的位置。',
  '交付说明：包含文档路径、结构概览和确认清单。',
].join('\n')

const DOC_REVIEWER_DESCRIPTION_EN = [
  'You are a Document Reviewer. Check a draft for accuracy and readability; do not rewrite the whole document by default.',
  'How to work:',
  '- Verify technical details against real code and files first.',
  '- Check structure, terminology consistency, and whether readers can follow the document.',
  '- List issues by severity with concrete edits or rewrite examples.',
  'Delivery: list factual errors first, then structure and wording issues.',
].join('\n')

const DOC_REVIEWER_DESCRIPTION_ZH = [
  '你是 Document Reviewer，负责检查草稿的准确性和可读性；默认不要整篇重写。',
  '工作方式：',
  '- 先对照项目真实代码和文件核对技术细节。',
  '- 检查结构、术语一致性，以及读者能否按文档完成操作。',
  '- 问题按严重度列出，给出具体修改建议或改写示例。',
  '交付说明：先列事实错误，再列结构和表达问题。',
].join('\n')

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'build_review_test',
    workers: [
      { nameStem: 'coder', role: 'coder' },
      { nameStem: 'reviewer', role: 'reviewer' },
      { nameStem: 'tester', role: 'tester' },
    ],
    goalTemplate: {
      en: 'Implement <feature>: have the Coder implement, Reviewer audit, and Tester verify; describe what to build, key constraints, and validation commands or acceptance criteria.',
      zh: '实现 X 功能：让 Coder 实现、Reviewer 审查、Tester 验证；写清楚要做什么、关键约束，以及验证命令或验收标准。',
    },
  },
  {
    id: 'research_factcheck',
    workers: [
      {
        nameStem: 'researcher',
        role: 'custom',
        descriptionOverride: { en: RESEARCHER_DESCRIPTION_EN, zh: RESEARCHER_DESCRIPTION_ZH },
      },
      {
        nameStem: 'factchecker',
        role: 'custom',
        descriptionOverride: { en: FACTCHECKER_DESCRIPTION_EN, zh: FACTCHECKER_DESCRIPTION_ZH },
      },
    ],
    goalTemplate: {
      en: 'Research <topic>: have the Researcher gather evidence and the Factchecker verify it; list questions, trusted sources, and the decision this research should support.',
      zh: '调研 X 主题：让 Researcher 收集证据、Factchecker 复核；列出要回答的问题、可信来源要求，以及这次调研要支撑的决策。',
    },
  },
  {
    id: 'docs_pipeline',
    workers: [
      {
        nameStem: 'drafter',
        role: 'custom',
        descriptionOverride: { en: DRAFTER_DESCRIPTION_EN, zh: DRAFTER_DESCRIPTION_ZH },
      },
      {
        nameStem: 'doc-reviewer',
        role: 'custom',
        descriptionOverride: {
          en: DOC_REVIEWER_DESCRIPTION_EN,
          zh: DOC_REVIEWER_DESCRIPTION_ZH,
        },
      },
    ],
    goalTemplate: {
      en: 'Write <doc>: have the Drafter write and the Doc Reviewer review; state the audience, scope, required sections, and code or files it should describe.',
      zh: '撰写 X 文档：让 Drafter 撰写、Doc Reviewer 审查；写明读者、范围、必备章节，以及它要描述的代码或文件。',
    },
  },
]

export const getScenarioPreset = (id: string): ScenarioPreset | undefined =>
  SCENARIO_PRESETS.find((preset) => preset.id === id)

export const getScenarioWorkerDescription = (
  spec: ScenarioWorkerSpec,
  language: UiLanguage
): string | undefined => spec.descriptionOverride?.[language]
