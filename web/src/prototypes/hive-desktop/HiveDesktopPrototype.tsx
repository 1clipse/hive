// PROTOTYPE — THROW AWAY.
// Three variants of a Codex-like Hive Desktop multi-agent conversation, switchable via ?variant=.

import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  FileCode2,
  FileText,
  GitBranch,
  Hexagon,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Mic,
  MoreHorizontal,
  PanelRight,
  Pause,
  Play,
  Plus,
  Search,
  SendHorizontal,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  Users,
  X,
} from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react'

type VariantKey = 'A' | 'B' | 'C'
type AgentId = 'orchestrator' | 'researcher' | 'builder' | 'reviewer'
type AgentStatus = 'working' | 'blocked' | 'done'
type RunState = 'running' | 'attention' | 'paused' | 'complete'
type Drawer = 'team' | 'tasks' | 'changes' | 'artifacts' | 'terminal' | null

type Agent = {
  id: AgentId
  name: string
  role: string
  model: string
  status: AgentStatus
  task: string
  summary: string
  elapsed: string
  color: string
  icon: LucideIcon
}

const defaultVariant: { key: VariantKey; name: string } = { key: 'A', name: 'Inline narrative' }

const variants: Array<{ key: VariantKey; name: string }> = [
  defaultVariant,
  { key: 'B', name: 'Persistent team rail' },
  { key: 'C', name: 'Team stage' },
]

const orchestratorAgent: Agent = {
  id: 'orchestrator',
  name: 'Queen',
  role: 'Orchestrator',
  model: 'Codex 5.6',
  status: 'working',
  task: '整合方案并控制修改边界',
  summary: '已拆成协议、实现、审阅三条独立路径',
  elapsed: '4m 18s',
  color: '#e9b65b',
  icon: Hexagon,
}

const agents: Agent[] = [
  orchestratorAgent,
  {
    id: 'researcher',
    name: 'Lin',
    role: 'Researcher',
    model: 'Claude Sonnet',
    status: 'done',
    task: '核验现有恢复链路与边界',
    summary: '找到 4 个可复用入口，标记 2 个协议冲突',
    elapsed: '2m 41s',
    color: '#7ba7e8',
    icon: Search,
  },
  {
    id: 'builder',
    name: 'Mori',
    role: 'Builder',
    model: 'Codex 5.6',
    status: 'working',
    task: '实现 report delivery adapter',
    summary: '正在打通 report → active turn steer',
    elapsed: '3m 06s',
    color: '#7bc89c',
    icon: Code2,
  },
  {
    id: 'reviewer',
    name: 'Iris',
    role: 'Reviewer',
    model: 'Gemini 2.5 Pro',
    status: 'blocked',
    task: '审阅权限继承与停止语义',
    summary: '需要确认：是否允许 worker 扩大网络范围',
    elapsed: '1m 52s',
    color: '#dc887e',
    icon: ShieldAlert,
  },
]

const recentConversations = [
  { title: '设计桌面端多 Agent 交互', meta: '运行中 · 4 agents', active: true },
  { title: '修复远程滚动与键盘遮挡', meta: '昨天 · 已完成', active: false },
  { title: '评估 workflow runtime', meta: '周一 · 已完成', active: false },
  { title: '检查 2.1.19 发布包', meta: '7 月 18 日', active: false },
]

const activity = [
  { time: '17:18:42', agent: 'Lin', text: '提交恢复链路核验报告', tone: 'done' },
  { time: '17:19:03', agent: 'Mori', text: '修改 report delivery adapter', tone: 'working' },
  { time: '17:19:28', agent: 'Iris', text: '请求网络权限边界确认', tone: 'blocked' },
  { time: '17:19:31', agent: 'Queen', text: '暂停依赖该决策的审阅分支', tone: 'working' },
]

const statusText: Record<AgentStatus, string> = {
  working: '工作中',
  blocked: '需要决策',
  done: '已完成',
}

const nextRunState: Record<RunState, RunState> = {
  running: 'attention',
  attention: 'complete',
  complete: 'paused',
  paused: 'running',
}

const readVariant = (): VariantKey => {
  const candidate = new URLSearchParams(window.location.search).get('variant')?.toUpperCase()
  return candidate === 'B' || candidate === 'C' ? candidate : 'A'
}

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, textarea, [contenteditable="true"]')
}

const HiveMark = ({ compact = false }: { compact?: boolean }) => (
  <div className={`hive-mark ${compact ? 'hive-mark--compact' : ''}`}>
    <span className="hive-mark__glyph">
      <Hexagon size={compact ? 15 : 17} strokeWidth={1.8} />
    </span>
    {!compact && <span>Hive</span>}
  </div>
)

const AgentAvatar = ({ agent, size = 'md' }: { agent: Agent; size?: 'sm' | 'md' | 'lg' }) => {
  const Icon = agent.icon
  return (
    <span
      className={`agent-avatar agent-avatar--${size}`}
      style={{ '--agent': agent.color } as CSSProperties}
    >
      <Icon aria-hidden="true" />
    </span>
  )
}

const StatusDot = ({ status }: { status: AgentStatus }) => (
  <span
    className={`status-dot status-dot--${status}`}
    role="status"
    aria-label={statusText[status]}
  >
    {status === 'working' ? <LoaderCircle /> : status === 'done' ? <Check /> : <span />}
  </span>
)

const ProjectSidebar = ({ compact = false }: { compact?: boolean }) => {
  if (compact) {
    return (
      <aside className="icon-sidebar" aria-label="项目导航">
        <HiveMark compact />
        <button type="button" className="icon-sidebar__new" aria-label="新建对话">
          <Plus />
        </button>
        <div className="icon-sidebar__projects">
          <button
            type="button"
            className="project-glyph project-glyph--active"
            aria-label="Hive private"
          >
            H
          </button>
          <button type="button" className="project-glyph" aria-label="Agent retrieval">
            A
          </button>
          <button type="button" className="project-glyph" aria-label="Maka agent">
            M
          </button>
        </div>
        <button type="button" className="icon-button icon-sidebar__settings" aria-label="设置">
          <Settings2 />
        </button>
      </aside>
    )
  }

  return (
    <aside className="project-sidebar">
      <div className="project-sidebar__brand">
        <HiveMark />
        <button type="button" className="icon-button" aria-label="搜索">
          <Search />
        </button>
      </div>
      <button type="button" className="new-conversation">
        <Plus />
        新对话
        <span>⌘ N</span>
      </button>
      <div className="sidebar-section">
        <p className="sidebar-label">项目</p>
        <button type="button" className="project-row project-row--active">
          <span className="project-row__mark">H</span>
          <span>hive</span>
          <ChevronDown />
        </button>
      </div>
      <nav className="conversation-list" aria-label="最近对话">
        <p className="sidebar-label">最近</p>
        {recentConversations.map((conversation) => (
          <button
            type="button"
            className={`conversation-row ${conversation.active ? 'conversation-row--active' : ''}`}
            key={conversation.title}
          >
            <span className="conversation-row__title">{conversation.title}</span>
            <span className="conversation-row__meta">{conversation.meta}</span>
          </button>
        ))}
      </nav>
      <div className="project-sidebar__footer">
        <button type="button" className="sidebar-footer-button">
          <Bell />
          活动
          <span className="notification-count">2</span>
        </button>
        <button type="button" className="sidebar-footer-button">
          <Settings2 />
          设置
        </button>
        <div className="runtime-status">
          <span /> Local runtime
          <small>127.0.0.1</small>
        </div>
      </div>
    </aside>
  )
}

const ConversationHeader = ({ onOpenTeam }: { onOpenTeam: () => void }) => (
  <header className="conversation-header">
    <div>
      <h1>设计桌面端多 Agent 交互</h1>
      <span>
        hive <b>/</b> main
      </span>
    </div>
    <div className="conversation-header__actions">
      <button type="button" className="quiet-button" onClick={onOpenTeam}>
        <Users />4 agents
      </button>
      <button type="button" className="icon-button" aria-label="更多选项">
        <MoreHorizontal />
      </button>
      <button type="button" className="icon-button" aria-label="打开右侧面板">
        <PanelRight />
      </button>
    </div>
  </header>
)

const UserPrompt = ({ followUp }: { followUp: string | null }) => (
  <>
    <div className="user-message">
      <p>桌面端界面大概就按 Codex App 这种对话形态，但多 Agent 的管理、交互和 UI 应该怎么设计？</p>
    </div>
    {followUp && (
      <div className="user-message user-message--follow-up">
        <p>{followUp}</p>
      </div>
    )}
  </>
)

const AssistantLead = () => (
  <section className="assistant-block">
    <div className="assistant-block__meta">
      <span className="assistant-icon">
        <Sparkles />
      </span>
      <span>Queen</span>
      <span>·</span>
      <span>Orchestrator</span>
    </div>
    <p>
      我会保留 Codex 的单列对话和低干扰 composer，把团队执行压缩成一张可展开的
      TeamRun。主对话负责目标、决策和验收；成员过程进入子线程，需要你时才提升到主线。
    </p>
  </section>
)

const RunHeader = ({ runState, onToggleRun }: { runState: RunState; onToggleRun: () => void }) => {
  const copy = {
    running: '团队处理中',
    attention: '需要你的决定',
    paused: '团队已暂停',
    complete: '团队已完成',
  }[runState]
  return (
    <div className="run-header">
      <div className="run-header__title">
        <span className={`run-pulse run-pulse--${runState}`} />
        <strong>{copy}</strong>
        <span>4m 18s</span>
      </div>
      <button type="button" className="run-control" onClick={onToggleRun}>
        {runState === 'paused' || runState === 'complete' ? <Play /> : <Square />}
        {runState === 'paused' || runState === 'complete' ? '继续' : '停止'}
      </button>
    </div>
  )
}

const AgentCompactRow = ({ agent, onOpen }: { agent: Agent; onOpen: (id: AgentId) => void }) => (
  <button type="button" className="agent-compact-row" onClick={() => onOpen(agent.id)}>
    <AgentAvatar agent={agent} size="sm" />
    <span className="agent-compact-row__main">
      <span>
        <strong>{agent.role}</strong>
        <small>{agent.name}</small>
      </span>
      <span>{agent.summary}</span>
    </span>
    <StatusDot status={agent.status} />
    <ChevronRight className="row-chevron" />
  </button>
)

const InlineTeamRun = ({
  runState,
  expanded,
  onToggleExpanded,
  onToggleRun,
  onOpenAgent,
  onOpenDrawer,
}: {
  runState: RunState
  expanded: boolean
  onToggleExpanded: () => void
  onToggleRun: () => void
  onOpenAgent: (id: AgentId) => void
  onOpenDrawer: (drawer: Drawer) => void
}) => (
  <section className={`team-run-card team-run-card--${runState}`}>
    <RunHeader runState={runState} onToggleRun={onToggleRun} />
    <div className="team-run-summary">
      <div className="avatar-stack" role="img" aria-label="4 个 Agent">
        {agents.map((agent) => (
          <AgentAvatar key={agent.id} agent={agent} size="sm" />
        ))}
      </div>
      <p>
        <strong>2</strong> 正在工作 <i /> <strong>1</strong> 已完成 <i /> <strong>1</strong>{' '}
        等待决定
      </p>
    </div>
    <button type="button" className="run-latest" onClick={() => onOpenAgent('reviewer')}>
      <ShieldAlert />
      <span>
        <b>Iris 需要确认网络权限</b>
        <small>“是否允许审阅 Agent 访问 GitHub API？”</small>
      </span>
      <span className="attention-action">处理</span>
    </button>
    {expanded && (
      <div className="team-run-agents">
        {agents.map((agent) => (
          <AgentCompactRow agent={agent} key={agent.id} onOpen={onOpenAgent} />
        ))}
      </div>
    )}
    <div className="team-run-footer">
      <button type="button" onClick={onToggleExpanded}>
        {expanded ? <ChevronDown /> : <ChevronRight />}
        {expanded ? '收起活动' : '展开活动'}
      </button>
      <button type="button" onClick={() => onOpenDrawer('team')}>
        打开 Team
      </button>
      <button type="button" onClick={() => onOpenDrawer('tasks')}>
        查看任务
      </button>
    </div>
  </section>
)

const ApprovalCard = ({
  decision,
  onDecision,
}: {
  decision: 'approved' | 'denied' | null
  onDecision: (decision: 'approved' | 'denied') => void
}) => (
  <section className={`approval-card ${decision ? 'approval-card--resolved' : ''}`}>
    <div className="approval-card__icon">
      {decision === 'approved' ? <CheckCircle2 /> : <ShieldAlert />}
    </div>
    <div className="approval-card__content">
      <div className="approval-card__heading">
        <div>
          <span>{decision ? '权限决定已记录' : 'Iris 请求网络访问'}</span>
          <small>Reviewer · Gemini 2.5 Pro</small>
        </div>
        <span className="scope-badge">本次会话</span>
      </div>
      <p>
        {decision
          ? decision === 'approved'
            ? '已允许只读访问 github.com。Iris 正在继续审阅。'
            : '已拒绝。Queen 会改用本地代码完成审阅。'
          : '为了核验 app-server 的权限继承实现，请求只读访问 github.com。不会向其他域名发送数据。'}
      </p>
      {!decision && (
        <div className="approval-card__actions">
          <button type="button" className="primary-action" onClick={() => onDecision('approved')}>
            允许一次
          </button>
          <button type="button" onClick={() => onDecision('denied')}>
            拒绝
          </button>
          <button type="button">查看请求详情</button>
        </div>
      )}
    </div>
  </section>
)

const FinalAnswer = ({ visible }: { visible: boolean }) => {
  if (!visible) return null
  return (
    <section className="final-answer">
      <div className="completion-separator">
        <span>已处理 6m 04s</span>
      </div>
      <h2>建议采用“主对话 + 可展开 TeamRun”</h2>
      <p>
        默认界面保持接近 Codex：用户只看任务、关键决定和最终结果。多 Agent
        不做常驻终端矩阵，而是作为一次运行的结构化活动，需要时展开到成员线程。
      </p>
      <ul>
        <li>主对话是唯一用户输入入口，定向消息也会让 Orchestrator 可见。</li>
        <li>TeamRun 卡承担总进度、阻塞和停止；成员线程承担工具、报告和 terminal 证据。</li>
        <li>审批必须提升到主线，普通 report 不打扰用户。</li>
      </ul>
      <div className="artifact-links">
        <button type="button">
          <GitBranch /> 12 files changed
        </button>
        <button type="button">
          <FileText /> interaction-notes.md
        </button>
      </div>
    </section>
  )
}

const Composer = ({
  value,
  runState,
  onChange,
  onSend,
}: {
  value: string
  runState: RunState
  onChange: (value: string) => void
  onSend: () => void
}) => (
  <div className="composer-wrap">
    <div className="composer">
      <textarea
        aria-label="给 Hive 发送消息"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSend()
          }
        }}
        placeholder={runState === 'running' ? '补充要求或纠正方向…' : '继续对话…'}
      />
      <div className="composer__toolbar">
        <div>
          <button type="button" className="icon-button" aria-label="添加附件">
            <Plus />
          </button>
          <button type="button" className="composer-option">
            <ShieldAlert /> Workspace
          </button>
          <button type="button" className="composer-option">
            <Users /> Auto team
          </button>
        </div>
        <div>
          <button type="button" className="model-button">
            Codex 5.6 <ChevronDown />
          </button>
          <button type="button" className="icon-button" aria-label="语音输入">
            <Mic />
          </button>
          <button type="button" className="send-button" onClick={onSend} aria-label="发送">
            {runState === 'running' ? <ArrowRight /> : <SendHorizontal />}
          </button>
        </div>
      </div>
    </div>
    <p>Enter 发送 · Shift + Enter 换行 · 运行中发送会 steer 当前 TeamRun</p>
  </div>
)

const AgentThreadPanel = ({
  agent,
  onClose,
  onOpenTerminal,
}: {
  agent: Agent
  onClose: () => void
  onOpenTerminal: () => void
}) => (
  <aside className="agent-thread-panel">
    <header className="agent-thread-panel__header">
      <div>
        <AgentAvatar agent={agent} />
        <span>
          <strong>{agent.name}</strong>
          <small>
            {agent.role} · {agent.model}
          </small>
        </span>
      </div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="关闭 Agent 线程">
        <X />
      </button>
    </header>
    <div className="agent-thread-panel__status">
      <StatusDot status={agent.status} />
      <span>{statusText[agent.status]}</span>
      <small>{agent.elapsed}</small>
    </div>
    <div className="agent-thread-panel__body">
      <section className="agent-brief">
        <span>当前任务</span>
        <p>{agent.task}</p>
      </section>
      <div className="thread-event thread-event--received">
        <span className="thread-event__icon">
          <ArrowRight />
        </span>
        <div>
          <small>收到派单 · Queen</small>
          <p>聚焦你负责的边界，完成后用结构化 report 返回证据和风险。</p>
        </div>
      </div>
      <div className="thread-event thread-event--tool">
        <span className="thread-event__icon">
          <Terminal />
        </span>
        <div>
          <small>命令 · 8s</small>
          <code>rg -n &quot;deliverUserInput|teamReport&quot; src</code>
          <span className="thread-event__result">完成 · 14 matches</span>
        </div>
      </div>
      <div className="thread-event thread-event--file">
        <span className="thread-event__icon">
          <FileCode2 />
        </span>
        <div>
          <small>正在修改</small>
          <p>src/server/orchestrator-delivery-adapter.ts</p>
          <span className="diff-stat">+64 −3</span>
        </div>
      </div>
      {agent.status === 'blocked' ? (
        <div className="thread-event thread-event--blocked">
          <span className="thread-event__icon">
            <ShieldAlert />
          </span>
          <div>
            <small>等待权限</small>
            <p>{agent.summary}</p>
          </div>
        </div>
      ) : (
        <div className="thread-event thread-event--report">
          <span className="thread-event__icon">
            <MessageSquareText />
          </span>
          <div>
            <small>{agent.status === 'done' ? '最终报告' : '进度报告'}</small>
            <p>{agent.summary}</p>
          </div>
        </div>
      )}
    </div>
    <footer className="agent-thread-panel__footer">
      <button type="button" onClick={onOpenTerminal}>
        <Terminal /> 打开原始终端
      </button>
      <button type="button">
        <MessageSquareText /> 定向补充
      </button>
    </footer>
  </aside>
)

const GenericDrawer = ({
  drawer,
  onClose,
}: {
  drawer: Exclude<Drawer, null>
  onClose: () => void
}) => {
  const title = {
    team: 'Team',
    tasks: 'Tasks',
    changes: 'Changes',
    artifacts: 'Artifacts',
    terminal: 'Raw terminal',
  }[drawer]

  return (
    <aside className={`generic-drawer generic-drawer--${drawer}`}>
      <header>
        <span>{title}</span>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={`关闭 ${title}`}
        >
          <X />
        </button>
      </header>
      {drawer === 'terminal' ? (
        <div className="terminal-surface">
          <div>
            <i className="terminal-dot terminal-dot--red" />
            <i className="terminal-dot terminal-dot--gold" />
            <i className="terminal-dot terminal-dot--green" />
          </div>
          <code>
            <span>$ hive team list</span>
            {'\n'}
            Queen working orchestrator{'\n'}
            Lin idle researcher{'\n'}
            Mori working builder{'\n'}
            Iris working reviewer{'\n\n'}
            <b>[hive]</b> waiting for report…
          </code>
        </div>
      ) : drawer === 'team' ? (
        <div className="drawer-list">
          {agents.map((agent) => (
            <div className="drawer-agent" key={agent.id}>
              <AgentAvatar agent={agent} />
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </span>
              <StatusDot status={agent.status} />
            </div>
          ))}
        </div>
      ) : drawer === 'tasks' ? (
        <div className="task-list">
          <p>
            <CheckCircle2 /> 核验现有恢复链路
          </p>
          <p>
            <LoaderCircle /> 实现 report delivery adapter
          </p>
          <p>
            <Pause /> 审阅权限与取消语义
          </p>
          <p>
            <Circle /> 汇总并验证方案
          </p>
        </div>
      ) : (
        <div className="drawer-empty">
          {drawer === 'changes' ? <GitBranch /> : <FileText />}
          <strong>{drawer === 'changes' ? '12 个文件发生变化' : '3 个运行产物'}</strong>
          <span>原型只展示信息层级，不读取真实项目数据。</span>
        </div>
      )}
    </aside>
  )
}

const ConversationBody = ({
  state,
  followUp,
  onToggleExpanded,
  onToggleRun,
  onOpenAgent,
  onOpenDrawer,
  onDecision,
}: {
  state: PrototypeState
  followUp: string | null
  onToggleExpanded: () => void
  onToggleRun: () => void
  onOpenAgent: (id: AgentId) => void
  onOpenDrawer: (drawer: Drawer) => void
  onDecision: (decision: 'approved' | 'denied') => void
}) => (
  <div className="conversation-scroll">
    <div className="conversation-column">
      <UserPrompt followUp={followUp} />
      <AssistantLead />
      <InlineTeamRun
        runState={state.runState}
        expanded={state.teamExpanded}
        onToggleExpanded={onToggleExpanded}
        onToggleRun={onToggleRun}
        onOpenAgent={onOpenAgent}
        onOpenDrawer={onOpenDrawer}
      />
      {(state.runState === 'attention' || state.approvalDecision) && (
        <ApprovalCard decision={state.approvalDecision} onDecision={onDecision} />
      )}
      <FinalAnswer visible={state.runState === 'complete'} />
    </div>
  </div>
)

type PrototypeState = {
  runState: RunState
  teamExpanded: boolean
  selectedAgent: AgentId | null
  drawer: Drawer
  approvalDecision: 'approved' | 'denied' | null
}

type VariantProps = {
  state: PrototypeState
  draft: string
  followUp: string | null
  onDraftChange: (value: string) => void
  onSend: () => void
  onToggleExpanded: () => void
  onToggleRun: () => void
  onOpenAgent: (id: AgentId) => void
  onOpenDrawer: (drawer: Drawer) => void
  onDecision: (decision: 'approved' | 'denied') => void
}

const OverlayPanels = ({
  state,
  onOpenAgent,
  onOpenDrawer,
}: Pick<VariantProps, 'state' | 'onOpenAgent' | 'onOpenDrawer'>) => {
  const selected = agents.find((agent) => agent.id === state.selectedAgent)
  return (
    <>
      {selected && (
        <AgentThreadPanel
          agent={selected}
          onClose={() => onOpenAgent(selected.id)}
          onOpenTerminal={() => onOpenDrawer('terminal')}
        />
      )}
      {state.drawer && (
        <GenericDrawer drawer={state.drawer} onClose={() => onOpenDrawer(state.drawer)} />
      )}
    </>
  )
}

const VariantA = (props: VariantProps) => (
  <div className="prototype-shell variant-a">
    <ProjectSidebar />
    <main className="conversation-surface">
      <ConversationHeader onOpenTeam={() => props.onOpenDrawer('team')} />
      <ConversationBody
        state={props.state}
        followUp={props.followUp}
        onToggleExpanded={props.onToggleExpanded}
        onToggleRun={props.onToggleRun}
        onOpenAgent={props.onOpenAgent}
        onOpenDrawer={props.onOpenDrawer}
        onDecision={props.onDecision}
      />
      <Composer
        value={props.draft}
        runState={props.state.runState}
        onChange={props.onDraftChange}
        onSend={props.onSend}
      />
    </main>
    <OverlayPanels
      state={props.state}
      onOpenAgent={props.onOpenAgent}
      onOpenDrawer={props.onOpenDrawer}
    />
  </div>
)

const TeamRail = ({ props }: { props: VariantProps }) => {
  const selected = agents.find((agent) => agent.id === props.state.selectedAgent)
  return (
    <aside className="team-rail">
      <header className="team-rail__header">
        <span>
          <Users /> Team
        </span>
        <button type="button" className="icon-button" aria-label="团队选项">
          <MoreHorizontal />
        </button>
      </header>
      <div className="team-rail__summary">
        <RunHeader runState={props.state.runState} onToggleRun={props.onToggleRun} />
        <div className="team-rail__metrics">
          <span>
            <strong>4</strong> agents
          </span>
          <span>
            <strong>3</strong> tasks
          </span>
          <span>
            <strong>1</strong> blocked
          </span>
        </div>
      </div>
      <div className="team-rail__agents">
        {agents.map((agent) => (
          <button
            type="button"
            key={agent.id}
            className={`rail-agent ${selected?.id === agent.id ? 'rail-agent--selected' : ''}`}
            onClick={() => props.onOpenAgent(agent.id)}
          >
            <AgentAvatar agent={agent} />
            <span>
              <strong>{agent.name}</strong>
              <small>
                {agent.role} · {agent.task}
              </small>
            </span>
            <StatusDot status={agent.status} />
          </button>
        ))}
      </div>
      <div className="team-rail__activity">
        <div className="rail-section-title">
          <Activity /> Live activity
        </div>
        {activity.map((item) => (
          <div className="rail-activity-row" key={`${item.time}-${item.agent}`}>
            <span className={`rail-activity-row__dot rail-activity-row__dot--${item.tone}`} />
            <span>
              <strong>{item.agent}</strong>
              {item.text}
              <small>{item.time}</small>
            </span>
          </div>
        ))}
      </div>
      <footer className="team-rail__footer">
        <button type="button" onClick={() => props.onOpenDrawer('tasks')}>
          <ListChecks /> Tasks
        </button>
        <button type="button" onClick={() => props.onOpenDrawer('terminal')}>
          <Terminal /> Terminal
        </button>
      </footer>
    </aside>
  )
}

const CompactRunLine = ({ onOpenTeam }: { onOpenTeam: () => void }) => (
  <button type="button" className="compact-run-line" onClick={onOpenTeam}>
    <span className="run-pulse run-pulse--running" />
    <strong>Hive team · 4 agents</strong>
    <span>2 working</span>
    <span>1 done</span>
    <span className="compact-run-line__attention">1 needs you</span>
    <ChevronRight />
  </button>
)

const VariantB = (props: VariantProps) => (
  <div className="prototype-shell variant-b">
    <ProjectSidebar compact />
    <main className="conversation-surface conversation-surface--rail">
      <ConversationHeader onOpenTeam={() => props.onOpenDrawer('team')} />
      <div className="conversation-scroll">
        <div className="conversation-column conversation-column--rail">
          <UserPrompt followUp={props.followUp} />
          <AssistantLead />
          <CompactRunLine onOpenTeam={() => props.onOpenAgent('orchestrator')} />
          {(props.state.runState === 'attention' || props.state.approvalDecision) && (
            <ApprovalCard decision={props.state.approvalDecision} onDecision={props.onDecision} />
          )}
          <FinalAnswer visible={props.state.runState === 'complete'} />
        </div>
      </div>
      <Composer
        value={props.draft}
        runState={props.state.runState}
        onChange={props.onDraftChange}
        onSend={props.onSend}
      />
    </main>
    <TeamRail props={props} />
    <OverlayPanels
      state={props.state}
      onOpenAgent={props.onOpenAgent}
      onOpenDrawer={props.onOpenDrawer}
    />
  </div>
)

const StageAgent = ({ agent, onOpen }: { agent: Agent; onOpen: (id: AgentId) => void }) => (
  <button
    type="button"
    className={`stage-agent stage-agent--${agent.status}`}
    onClick={() => onOpen(agent.id)}
  >
    <div className="stage-agent__top">
      <AgentAvatar agent={agent} />
      <span>
        <strong>{agent.name}</strong>
        <small>{agent.role}</small>
      </span>
      <StatusDot status={agent.status} />
    </div>
    <p>{agent.task}</p>
    <div className="stage-agent__footer">
      <span>{agent.elapsed}</span>
      <span>
        {agent.status === 'done' ? '1 report' : agent.status === 'blocked' ? 'approval' : 'live'}
      </span>
    </div>
  </button>
)

const TeamStage = ({ props }: { props: VariantProps }) => (
  <section className="team-stage">
    <header className="team-stage__header">
      <div>
        <span className={`run-pulse run-pulse--${props.state.runState}`} />
        <strong>Team stage</strong>
        <span>4 agents · 3 branches · 4m 18s</span>
      </div>
      <div>
        <button type="button" onClick={() => props.onOpenDrawer('tasks')}>
          <ListChecks /> Tasks
        </button>
        <button type="button" onClick={props.onToggleRun}>
          {props.state.runState === 'paused' ? <Play /> : <Square />}
          {props.state.runState === 'paused' ? 'Resume' : 'Stop all'}
        </button>
      </div>
    </header>
    <div className="stage-flow" role="img" aria-label="Agent 并行执行图">
      <div className="stage-orchestrator">
        <StageAgent agent={orchestratorAgent} onOpen={props.onOpenAgent} />
      </div>
      <div className="stage-connector stage-connector--left" />
      <div className="stage-connector stage-connector--right" />
      <div className="stage-workers">
        {agents.slice(1).map((agent) => (
          <StageAgent agent={agent} key={agent.id} onOpen={props.onOpenAgent} />
        ))}
      </div>
    </div>
    <div className="stage-ticker">
      {activity.slice(0, 3).map((item) => (
        <span key={`${item.time}-${item.agent}`}>
          <b>{item.agent}</b> {item.text}
          <small>{item.time}</small>
        </span>
      ))}
    </div>
  </section>
)

const VariantC = (props: VariantProps) => (
  <div className="prototype-shell variant-c">
    <ProjectSidebar compact />
    <main className="stage-layout">
      <ConversationHeader onOpenTeam={() => props.onOpenDrawer('team')} />
      <div className="stage-layout__conversation">
        <div className="conversation-column conversation-column--stage">
          <UserPrompt followUp={props.followUp} />
          <AssistantLead />
          {(props.state.runState === 'attention' || props.state.approvalDecision) && (
            <ApprovalCard decision={props.state.approvalDecision} onDecision={props.onDecision} />
          )}
          <FinalAnswer visible={props.state.runState === 'complete'} />
        </div>
      </div>
      <TeamStage props={props} />
      <Composer
        value={props.draft}
        runState={props.state.runState}
        onChange={props.onDraftChange}
        onSend={props.onSend}
      />
    </main>
    <OverlayPanels
      state={props.state}
      onOpenAgent={props.onOpenAgent}
      onOpenDrawer={props.onOpenDrawer}
    />
  </div>
)

const PrototypeSwitcher = ({
  current,
  state,
  onSwitch,
  onCycleState,
}: {
  current: VariantKey
  state: PrototypeState
  onSwitch: (direction: -1 | 1) => void
  onCycleState: () => void
}) => {
  if (!import.meta.env.DEV) return null
  const variant = variants.find((item) => item.key === current) ?? defaultVariant
  const stateLabel = `run=${state.runState} · agent=${state.selectedAgent ?? 'none'} · drawer=${state.drawer ?? 'none'} · approval=${state.approvalDecision ?? 'pending'}`
  return (
    <div className="prototype-switcher" role="toolbar" aria-label="原型方案切换器">
      <button type="button" onClick={() => onSwitch(-1)} aria-label="上一个方案">
        <ArrowLeft />
      </button>
      <button
        type="button"
        className="prototype-switcher__label"
        onClick={onCycleState}
        title="点击切换运行状态"
      >
        <strong>
          {variant.key} — {variant.name}
        </strong>
        <span>{stateLabel}</span>
      </button>
      <button type="button" onClick={() => onSwitch(1)} aria-label="下一个方案">
        <ArrowRight />
      </button>
    </div>
  )
}

export const HiveDesktopPrototype = () => {
  const [variant, setVariant] = useState<VariantKey>(readVariant)
  const [draft, setDraft] = useState('')
  const [followUp, setFollowUp] = useState<string | null>(null)
  const [state, setState] = useState<PrototypeState>({
    runState: 'attention',
    teamExpanded: false,
    selectedAgent: null,
    drawer: null,
    approvalDecision: null,
  })

  const switchVariant = useCallback((direction: -1 | 1) => {
    setVariant((current) => {
      const index = variants.findIndex((item) => item.key === current)
      const next =
        variants[(index + direction + variants.length) % variants.length] ?? defaultVariant
      const url = new URL(window.location.href)
      url.searchParams.set('variant', next.key)
      window.history.replaceState({}, '', url)
      return next.key
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (event.key === 'ArrowLeft') switchVariant(-1)
      if (event.key === 'ArrowRight') switchVariant(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [switchVariant])

  const selectedVariant = useMemo(() => variants.find((item) => item.key === variant), [variant])

  const props: VariantProps = {
    state,
    draft,
    followUp,
    onDraftChange: setDraft,
    onSend: () => {
      const message = draft.trim()
      if (!message) return
      setFollowUp(message)
      setDraft('')
      setState((current) => ({ ...current, runState: 'running' }))
    },
    onToggleExpanded: () =>
      setState((current) => ({ ...current, teamExpanded: !current.teamExpanded })),
    onToggleRun: () =>
      setState((current) => ({
        ...current,
        runState: current.runState === 'paused' ? 'running' : 'paused',
      })),
    onOpenAgent: (id) =>
      setState((current) => ({
        ...current,
        drawer: null,
        selectedAgent: current.selectedAgent === id ? null : id,
      })),
    onOpenDrawer: (drawer) =>
      setState((current) => ({
        ...current,
        selectedAgent: null,
        drawer: current.drawer === drawer ? null : drawer,
      })),
    onDecision: (approvalDecision) =>
      setState((current) => ({
        ...current,
        approvalDecision,
        runState: approvalDecision === 'approved' ? 'running' : 'attention',
      })),
  }

  return (
    <div className="prototype-root" data-variant={selectedVariant?.key ?? 'A'}>
      <div className="prototype-watermark">THROWAWAY UI PROTOTYPE</div>
      {variant === 'A' && <VariantA {...props} />}
      {variant === 'B' && <VariantB {...props} />}
      {variant === 'C' && <VariantC {...props} />}
      <PrototypeSwitcher
        current={variant}
        state={state}
        onSwitch={switchVariant}
        onCycleState={() =>
          setState((current) => ({ ...current, runState: nextRunState[current.runState] }))
        }
      />
    </div>
  )
}
