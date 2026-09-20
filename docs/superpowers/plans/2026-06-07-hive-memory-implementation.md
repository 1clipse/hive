# Hive Team Memory — 实施 Plan（M1+M2）

**Date**: 2026-06-07
**Spec**: `docs/superpowers/specs/2026-06-07-hive-memory-research.md`（方向已定稿，见 Decisions 区）
**范围**: M1（情景 + 语义 + 注入 + 导出 + UI）+ M2（Dream 离线自动整理）。M3 provider bridge（EverOS）不在本次范围。
**质量门**: 真实 HTTP + 真实 SQLite 集成测试（不 mock PTY/node-pty），每个可交付切片跑对应 vitest + `pnpm check`，阶段交付跑 `pnpm check && pnpm build && pnpm test`，并按 `AGENTS.md §4` 完成 4 个并行 reviewer 自评。**UI 不写测试**（项目约定，见 `AGENTS.md §三` 测试范围）：`web/` 改动以 tsc + biome + build + 真机走查为准，测试只覆盖核心逻辑。

## 目标一句话

让团队的协作历史（情景层）和沉淀的项目知识（语义层）在派单与恢复时自动到场、按需可查；空闲时 Dream 自动整理，事后可审计、可回滚，无审批门。

## 已定决策（不再讨论）

1. 归属：`workspace_id`；worker/role 只做来源快照，无硬外键。
2. 写入：orchestrator `team memory add` → active；worker → candidate。
3. 存储：SQLite 是 source of truth；单向导出 `<workspace>/.hive/memory.md`，不反向同步。
4. Dream：离线批处理，**自动生效，无用户审批门**。护栏全是被动的：`source: dream` 标记 + confidence、注入排序显式 > dream、diff 报告、整 run 一键 revert、workspace 开关。
5. 注入三点：startup（pinned + digest）、dispatch（top-K，`<hive-memory>` 块）、recovery（有界 digest）。不注入 `team list`。
6. Dream 执行体：**ephemeral headless CLI agent**（复用 workspace 配置的 CLI 与用户认证，如 `claude -p`），不引入 API key。

## 架构总览

```
                    ┌─ team recall ──────────► messages_fts + dispatches_fts (FTS5 evidence)
agent (PTY) ── team CLI ── HTTP /api/team/* ──┤
                    └─ team memory * ────────► memory-store ──► memory_entries/_sources/_injections
                                                   │
startup-instructions ◄── digest ───────────────────┤
agent-stdin-dispatcher ◄── top-K ──────────────────┤──► .hive/memory.md exporter (单向, debounced)
recovery-summary ◄── digest ───────────────────────┤
                                                   │
dream-runner (scheduled/idle/manual) ── headless CLI ──► ops JSON ──► 校验 ──► 原子应用 + dream_runs 报告/revert_blob
```

## Schema（migration v25 + v26 + v27 + v28）

### v25 — recall FTS（Issue 1）

```sql
-- FTS：external-content 模式，trigger 同步，迁移时 backfill 既有行
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');
CREATE VIRTUAL TABLE dispatches_fts USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
CREATE VIRTUAL TABLE dispatches_fts_trigram USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');
-- + INSERT/UPDATE/DELETE triggers for messages / dispatches
-- + rebuild/backfill 既有 rows；initializeRuntimeDatabase 在所有历史 migration 后 ensure 一次，兼容 foreign-built DB
```

注意：messages / dispatches 表已有数据，backfill 在迁移内完成；`team recall` 同时查 messages 与 dispatches，unicode61 优先、trigram 兜底（CJK 子串），结果按来源表 + rowid 去重合并。

### v26 — memory 基础（Issue 2）

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,                       -- scope='user' 时为 NULL
  scope TEXT NOT NULL DEFAULT 'workspace', -- workspace | user
  kind TEXT NOT NULL,                      -- fact | preference | decision | pitfall | procedure_ref
  body TEXT NOT NULL,
  tags TEXT,                               -- JSON array
  status TEXT NOT NULL,                    -- active | candidate | archived | rejected
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | dream
  confidence REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  last_injected_at INTEGER
);
CREATE INDEX idx_memory_entries_ws_status ON memory_entries(workspace_id, status);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_type TEXT NOT NULL,               -- manual | message | dispatch | report | dream
  source_id TEXT,
  source_sequence INTEGER,                 -- messages.sequence
  excerpt TEXT,
  text_hash TEXT,
  actor_agent_id_snapshot TEXT,
  actor_name_snapshot TEXT,
  actor_role_snapshot TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_sources_memory ON memory_sources(memory_id);

CREATE TABLE memory_injections (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  workspace_id TEXT,
  target_agent_id_snapshot TEXT,
  context_type TEXT NOT NULL,              -- startup | dispatch | recovery | manual_search
  dispatch_id TEXT,
  injected_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_injections_ws ON memory_injections(workspace_id, injected_at);
```

### v27 — memory FTS（Issue 3）

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(body, tags, content='memory_entries', tokenize='unicode61');
CREATE VIRTUAL TABLE memory_fts_trigram USING fts5(body, tags, content='memory_entries', tokenize='trigram');
-- + INSERT/UPDATE/DELETE triggers for memory_entries
```

### v28 — dream（Issue 8/9/10）

```sql
CREATE TABLE dream_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger TEXT NOT NULL,                   -- manual | scheduled
  status TEXT NOT NULL,                    -- running | completed | failed | reverted
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_seq_from INTEGER,                  -- 本次消费的 messages.sequence 窗口
  input_seq_to INTEGER,
  report TEXT,                             -- JSON diff: {added[], merged[], archived[], rewritten[]}
  revert_blob TEXT,                        -- 被改动条目的 prior state JSON（revert 用）
  error TEXT
);
CREATE INDEX idx_dream_runs_ws ON dream_runs(workspace_id, started_at);
```

workspace 删除时级联清理所有 memory_* / dream_runs 行（对齐现有 workspace 删除路径的做法）。

## 注入预算（常量，集中定义）

| 注入点 | 内容 | 预算 |
|---|---|---|
| startup | pinned 全量 + 最新 active digest | ≤ 1200 chars |
| dispatch | top-K=5，FTS(任务文本) + tags + role hint 排序，显式 > dream，confidence 降权 | ≤ 1500 chars |
| recovery | pinned + 高信号 digest（现有 recovery 事实优先） | ≤ 800 chars |

dispatch 注入格式：

```
<hive-memory>
Team memory that may be relevant (workspace knowledge, verify before relying on it):
- [pitfall, from Coder@2026-06-01] vitest 的 PTY 测试必须串行跑，并行会抢端口
- [decision] 本项目用 pnpm，不要用 npm
</hive-memory>
```

每次注入写 memory_injections + 更新 last_injected_at。

## 命令与策略

```bash
team recall "<query>" [--limit <n>] [--window <n>]     # orch + worker
team memory search "<query>"                            # orch + worker
team memory show <memory-id>                            # orch + worker
team memory add "<body>" [--kind ...] [--tag ...]       # orch → active；worker → candidate
team memory forget <memory-id>                          # 仅 orch（archive，不物理删）
```

`requireCommandForRole` 按上表扩展；startup instructions 给 orch/worker 各自补一段命令说明（orch 版强调"worker 报告里有价值的发现要 memory add 沉淀"）。

## Dream 设计（M2）

- **执行体**：ephemeral headless CLI agent。dream-runner 拼输入包（上次 run 之后的 protocol messages 窗口 + 当前全部 entries），以 headless 单次调用跑 workspace 默认 CLI，要求输出严格 JSON ops。
- **ops 契约**：
  ```json
  {"ops":[
    {"op":"add","kind":"pitfall","body":"...","tags":[],"confidence":0.8,"sources":[{"sequence":123}]},
    {"op":"merge","into":"<id>","from":["<id>"],"body":"合并后的表述"},
    {"op":"rewrite","id":"<id>","body":"相对日期转绝对/澄清表述"},
    {"op":"archive","id":"<id>","reason":"stale"}
  ]}
  ```
- **校验**（拒绝即整 run fail，不部分应用）：id 必须属于本 workspace；add ≤ 10/run；body ≤ 500 chars；archive 不删除；未知 op/id 拒绝。
- **应用**：单事务原子应用；改动前条目状态全量存入 revert_blob；新条目 source='dream' + confidence。
- **revert**：还原 revert_blob 中的 prior state，本 run 新增条目转 archived，run 状态 → reverted。
- **触发**：手动按钮 + 定时（默认开，每日一次，仅当该 workspace 自上次 run 后新增 messages ≥ 20 且当前无 working agent 时执行）。
- **判据**：prompt 要求以协议证据（report 内容、dispatch 成败）为准，不采信 agent 自我评价；明确"没有值得记的就返回空 ops，空 ops 是正常结果"（反 Hermes 激进偏置）。
- **开关**：per-workspace（memory 总开关 + dream 子开关）。

## 导出器

- 触发：memory 写路径 + dream run 完成后，debounce ~2s。
- 产物：`<workspace>/.hive/memory.md`——头部声明"generated, do not edit"；按 kind 分节列 active（带 pinned 标记、来源标签）；末尾 Dream changelog（最近 N 次 run 的 diff 摘要）。
- 不 watch、不反向同步。

## UI（完整版）

- `web/src/memory/WorkspaceMemoryDrawer.tsx`，与 Workflows/Tasks drawer 平级入口。
- Tabs：Active / Candidate / Archived / Dreams。
- Active：搜索框 + kind/tag 筛选；条目展开看来源证据（excerpt + actor 快照 + 时间）与 last_injected_at；pin / disable / archive 操作。
- Candidate：approve / reject（approve 即 active）。
- Dreams：run 历史 + diff 报告 + Run now 按钮 + Revert 按钮。
- Settings：workspace memory 总开关、dream 开关与节奏。
- 派单观测：dispatch 详情处显示"本次注入了哪些 memory"（查 memory_injections）。
- 远程/移动端：不要假设 gateway origin 暴露 `/api/*`；gateway 明确不做 `/api/*` proxy，手机请求通过 E2E relay 到 daemon/runtime。新增 memory routes 要走现有 runtime route + remote tunnel auth 审查，并补远程请求回归用例。

## Issue 拆分（tracer bullet）

执行切法采用纵切 issue，而不是原来的 PR1-5 层切法。每个 issue 都要从 schema/store 到 route/CLI/UI 和测试纵切到底，合并后能单独演示。旧 PR1-5 只作为架构层参考，不作为发包或派工单位。

| # | 标题 | 类型 | Blocked by | 验收时能演示什么 |
|---|---|---|---|---|
| 1 | `team recall`：协作历史 FTS 检索端到端 | AFK | 无 | worker 终端里 recall 查到历史 report 原文窗口（messages + dispatches、CJK、含远程回归用例） |
| 2 | `team memory add/show`：显式记忆写入端到端 | AFK | 无 | orch add → active、worker add → candidate，落库带 actor 快照（建 entries/sources/injections 三表） |
| 3 | `team memory search/forget` + memory FTS | AFK | 2 | FTS 搜记忆条目；forget 仅 orch 可用（archive 不物理删） |
| 4 | Startup + recovery digest 注入 | AFK | 2 | agent 启动/恢复 prompt 带 pinned + digest 块，审计落库，开关可关 |
| 5 | Dispatch top-K `<hive-memory>` 注入 | AFK | 3 | 派单 payload 自动带相关记忆（显式 > dream 排序、预算截断、审计） |
| 6 | `.hive/memory.md` 单向导出器 | AFK | 2 | add 一条记忆 → 文件 debounce 更新（generated 头 + 手改备份护栏） |
| 7 | Memory 面板：审批 API + 四 tab UI + 开关 + 注入观测 | HITL | 3, 5 | UI 里看/搜/批/删记忆，dispatch 详情显示注入了什么（API 有测试，UI 真机走查） |
| 8 | Dream runner + 手动触发 | AFK | 3 | curl 触发 dream run → headless stub CLI → ops 原子应用 + diff 报告落库 |
| 9 | Dream revert | AFK | 8 | 一键还原整次 run（prior state 还原、新条目转 archived） |
| 10 | Dream 调度器（每日 + idle + 增量阈值） | AFK | 8 | 条件满足自动跑，dream 子开关可关 |
| 11 | Dreams tab + 导出 changelog + prompt 真机校准 | HITL | 7, 8, 9 | UI 看 run 历史/diff/Run now/Revert；真实 claude headless 校准 prompt |
| 12 | 交付闸门：全量测试 + 走查 + README + §4 自评 | HITL | 全部 | 完整链路走查 + 4 reviewer 报告 |

并行性：

- 1、2、6 可以同时开工。
- 2 完成后 3、4、6 并行。
- 3 完成后 5、8 并行。
- 7 等 5：否则 UI 能先上，但"注入观测"会被拆成半成品，不符合纵切原则。
- 9、10 暂不并入 8：Dream 手动触发、revert、调度器各自有独立风险面和可演示验收点。

发布到 issue tracker 时：

- AFK issue 打 `ready-for-agent`。
- HITL issue 打 `ready-for-human`。
- issue body 必须包含：目标、范围、实现提示、验收标准、测试/验证、Blocked by。

## 阶段任务清单（按 issue 纵切）

### Issue 1 — `team recall`：协作历史 FTS 检索端到端
- [x] migration v25 中建立 messages + dispatches FTS（unicode61 + trigram）与 triggers/backfill，schema_version=25
- [x] v25 FTS rebuild 已改为 health-probe gated：缺表或索引失配才 rebuild，健康索引启动时不再 O(历史行数) 重建
- [x] 独立 recall store 提供 `recallMessages(workspaceId, query, limit, window)`
- [x] `/api/team/recall` 路由：agent 鉴权；orch + worker 可用；HTTP/JSON 继续 snake_case
- [x] `src/cli/team.ts` 增加 `team recall "<query>" [--limit <n>] [--window <n>]`
- [x] 远程回归：确认请求经 E2E relay 到 runtime，不假设 gateway `/api/*` proxy
- [x] 测试：真实 SQLite migration/backfill/triggers、CJK trigram、真实 HTTP + team CLI 请求路径、远程请求路径回归

### Issue 2 — `team memory add/show`：显式记忆写入端到端
- [x] v26 中建立 `memory_entries` / `memory_sources` / `memory_injections`
- [x] `memory-store.ts`：addEntry / getEntryWithSources / logInjections
- [x] `/api/team/memory/add`、`/api/team/memory/show`
- [x] `team memory add`、`team memory show`
- [x] 写入策略：orchestrator add → active；worker add → candidate；actor id/name/role 只做 snapshot，无硬 FK
- [x] 测试：真实 HTTP + SQLite + team CLI，覆盖 actor 快照、worker candidate、orchestrator active、workspace 隔离

### Issue 3 — `team memory search/forget` + memory FTS
- [x] migration v27 建 `memory_fts` + `memory_fts_trigram` triggers/backfill
- [x] `memory-store.ts`：searchEntries / archiveEntry / approveCandidate / rejectCandidate / setPinned / setDisabled
- [x] `/api/team/memory/search`、`/api/team/memory/forget`
- [x] `team memory search`、`team memory forget`
- [x] 策略：search/show orch + worker；forget 仅 orchestrator；forget 是 archive，不物理删
- [x] 测试：FTS 搜索、CJK、forget authz、archive 后不出现在 active search、源证据仍可审计

### Issue 4 — Startup + recovery digest 注入
- [x] digest 查询：pinned + 高信号 active，预算内截断
- [x] `agent-startup-instructions.ts` 注入 pinned/digest 块和 memory 命令说明
- [x] `recovery-summary.ts` 追加有界 digest，现有 recovery facts 仍优先
- [x] memory 总开关关闭时 startup/recovery 静默跳过
- [x] 注入审计写 `memory_injections`
- [x] 测试：启动/恢复 payload 含/不含 memory 块、预算截断、审计行落库、开关关闭

### Issue 5 — Dispatch top-K `<hive-memory>` 注入
- [x] `agent-stdin-dispatcher.ts` 在 dispatch payload 中注入 top-K `<hive-memory>` 块
- [x] 排序：显式 > dream；confidence 降权；任务文本 FTS + tags + role hint
- [x] 预算 ≤ 1500 chars；提示包含 "verify before relying"
- [x] 每次注入写 `memory_injections` + 更新 `last_injected_at`
- [x] memory 总开关关闭时跳过
- [x] 测试：派单 payload、排序、预算截断、审计、关闭开关、无相关 memory 时不插空块

### Issue 6 — `.hive/memory.md` 单向导出器
- [x] `team-memory-export.ts` debounced 单向导出
- [x] 输出 `<workspace>/.hive/memory.md`，generated 头，按 kind 分节，含来源标签和 Dream changelog
- [x] 不 watch、不反向同步
- [x] 用户手改检测：导出前发现非导出内容时保留备份副本
- [x] 测试：真实文件系统，add/update/archive 后导出，debounce，手改备份护栏

### Issue 7 — Memory 面板：审批 API + 四 tab UI + 开关 + 注入观测
- [x] UI routes：workspace memory list/search/approve/reject/archive/pin/disable/settings
- [x] `web/src/memory/WorkspaceMemoryDrawer.tsx`：Active / Candidate / Archived / Dreams tabs
- [x] Candidate approve/reject；Active pin/disable/archive；source evidence 展开
- [x] workspace memory 总开关 + dream 开关
- [x] dispatch 详情显示本次注入了哪些 memory
- [x] 测试：API 真 HTTP + SQLite；UI 不写测试，跑 tsc/biome/build + HTTP smoke
- [x] 2026-06-08 追加本地 UI API smoke：真实 runtime + UI session cookie + 临时 workspace，验证 `GET /memory/settings`、`GET /memory`、`GET /memory/dream-runs`、`PUT /memory/settings`、memory disabled 时 manual Dream run 返回 409；临时 workspace 204 删除

### Issue 8 — Dream runner + 手动触发
- [x] migration v28 建 `dream_runs`
- [x] `dream-runner.ts`：输入包构建 / headless CLI 调用 / ops JSON 解析
- [x] 校验：id 属于 workspace、add ≤ 10/run、body ≤ 500 chars、未知 op/id 拒绝、拒绝即整 run fail
- [x] 单事务原子应用；report 写 diff；revert_blob 记录 prior state
- [x] 手动触发 route/API
- [x] 测试：PATH 上真实 stub 可执行文件（真子进程，非 mock），空 ops、非法 ops、原子性、跨 workspace 拒绝、dream 开关关闭

### Issue 9 — Dream revert
- [x] revert route/API
- [x] 还原 revert_blob 中 prior state
- [x] 本 run 新增条目转 archived；run 状态 → reverted
- [x] repeated revert 幂等或明确 409
- [x] 测试：整 run revert、partial prior state、new entries archive、重复 revert、跨 workspace 拒绝

### Issue 10 — Dream 调度器（每日 + idle + 增量阈值）
- [x] 每 workspace 定时检查：默认每日一次
- [x] 条件：上次 run 后新增 messages ≥ 20，当前无 working agent，dream 子开关开启
- [x] 不阻塞 live work；失败只记录 dream_runs error
- [x] 输入窗口只喂 `user_input/send/report`，system/status 类消息不触发阈值也不夹带进 Dream prompt
- [x] 测试：条件满足自动跑、working agent 时不跑、阈值不足不跑、开关关闭不跑、manual/failed 窗口不重放、mixed window 过滤

### Issue 11 — Dreams tab + 导出 changelog + prompt 真机校准
- [x] UI Dreams tab 接通 run history/diff/Run now/Revert
- [x] `.hive/memory.md` 追加最近 N 次 Dream changelog
- [x] 真实 claude headless dogfood 一轮，校准 dream prompt
- [x] API 有测试；UI 代码通过 `pnpm check && pnpm build`；记录 prompt 校准结果
- [ ] HITL UI 真机/人工走查

#### Issue 11 prompt 校准记录

- 时间：2026-06-08（Asia/Shanghai）
- 命令：`claude -p --disallowedTools '*'`
- 输入：synthetic Dream prompt，包含 `user_input` 要求记住 pnpm、一个有证据的 `report`、一个只有自夸无证据的 `report`
- 结果：exit 0，输出严格 JSON：`{"ops":[{"op":"add","kind":"preference",...}]}`
- 结论：当前 prompt 能让 Claude headless 生成合法 ops；它使用了 `user_input` + 具体 `report` 作为 sources，没有把无证据自夸写入 memory。无需调整 Dream prompt。

### Issue 12 — 交付闸门：全量测试 + 走查 + README + §4 自评
- [x] 全量 `pnpm check && pnpm build && pnpm test`（2026-06-08：335 files / 2162 tests passed，3 skipped；build 仅既有 Vite/Radix/lucide/chunk warnings；随后只新增 1 条 Dream memory 总开关回归测试，未重跑全量）
- [x] 外部 reviewer 最新全量回归报告：336 test files 全过（335 passed + 1 skipped），2166 cases（2163 passed + 3 skipped），exit 0，约 8.5 分钟
- [x] 真实 workspace 链路由集成测试覆盖：add/show/search/forget、startup/recovery/dispatch injection、recall、Dream run/history/changelog/revert、remote relay
- [x] 本地 runtime smoke：真实 UI session + 临时 workspace 覆盖 memory settings/list/dream history 和 disabled-run 409；未替代真机 UI walkthrough
- [x] 最新 targeted：`pnpm exec vitest run tests/server/team-memory-dream-runner.test.ts`（48 tests passed）；`pnpm exec vitest run tests/server/schema-version.test.ts tests/server/team-recall-api.test.ts`（26 tests passed）；`pnpm check`
- [x] README "在路上" 一节更新进度；spec 文档状态行更新
- [x] 按 `AGENTS.md §4` 并行派出 4 个 reviewer（架构、真实 bug、测试质量、spec 对齐），所有维度 ≥ B-
- [x] 自查 AGENTS.md §五 交付清单

## Completion Evidence Matrix

| Issue | 主要实现证据 | 测试 / 验证证据 | 当前状态 |
|---|---|---|---|
| 1 recall FTS | `sqlite-schema-v25.ts`, `team-recall-store.ts`, `routes-team-recall.ts`, `team.ts` | `schema-version.test.ts`, `team-recall-store.test.ts`, `team-recall-api.test.ts`, `team-cli.test.ts`, `remote-tunnel-bridge.test.ts` | AFK 完成 |
| 2 memory add/show | `sqlite-schema-v26.ts`, `team-memory-store.ts`, `routes-team-memory.ts`, `team.ts` | `team-memory-store.test.ts`, `team-memory-api.test.ts`, `team-cli.test.ts` | AFK 完成 |
| 3 memory search/forget | `sqlite-schema-v27.ts`, `team-memory-store.ts`, `team-authz.ts`, `routes-team-memory.ts` | `schema-version.test.ts`, `team-memory-store.test.ts`, `team-memory-api.test.ts`, `team-cli.test.ts` | AFK 完成 |
| 4 startup/recovery injection | `team-memory-digest.ts`, `team-memory-injection.ts`, `agent-startup-instructions.ts`, `recovery-summary.ts` | `agent-startup-instructions.test.ts`, `layer-b-fallback.test.ts`, `team-memory-digest.test.ts` | AFK 完成 |
| 5 dispatch injection | `agent-stdin-dispatcher.ts`, `team-memory-digest.ts`, `team-memory-injection.ts` | `team-prompt-contract.test.ts`, `agent-stdin-write-queue.test.ts` | AFK 完成 |
| 6 memory.md export | `team-memory-export.ts`, memory write paths, Dream completion/revert paths | `team-memory-export.test.ts`, `team-memory-dream-runner.test.ts` | AFK 完成 |
| 7 memory UI/API | `routes-workspace-memory.ts`, `web/src/memory/WorkspaceMemoryDrawer.tsx`, `web/src/api.ts`, `Topbar.tsx` | `team-memory-ui-api.test.ts`, local UI API smoke with real runtime + UI cookie + temp workspace | API/build/smoke 完成；真机 UI walkthrough 待 HITL |
| 8 Dream runner/manual | `sqlite-schema-v28.ts`, `team-memory-dream-runner.ts`, `team-memory-dream-applier.ts`, `routes-workspace-memory-dreams.ts` | `team-memory-dream-runner.test.ts` real PATH stub child process, local disabled-run smoke | AFK 完成 |
| 9 Dream revert | `team-memory-dream-reverter.ts`, `team-memory-dream-run-store.ts`, `routes-workspace-memory-dreams.ts` | `team-memory-dream-runner.test.ts` revert/repeated/cross-workspace cases | AFK 完成 |
| 10 Dream scheduler | `team-memory-dream-scheduler.ts`, `runtime-store-dream.ts`, run-store window filtering | `team-memory-dream-runner.test.ts` scheduler/idle/threshold/stale/mixed-window cases | AFK 完成 |
| 11 Dreams tab/export/prompt | `WorkspaceMemoryDrawer.tsx`, `team-memory-export.ts`, Dream prompt calibration record | `pnpm check && pnpm build`, `team-memory-dream-runner.test.ts`, `claude -p --disallowedTools '*'` dogfood record | API/build/prompt 完成；真机 UI walkthrough 待 HITL |
| 12 delivery gate | README/spec/plan updates, §4 self-review reports and verdicts | Full gate: `pnpm check && pnpm build && pnpm test`; latest targeted: Dream runner 48 tests + `pnpm check` | 除真机 UI walkthrough 外完成 |

## HITL Walkthrough Checklist

这部分是当前唯一未完成项。执行人需要在真实浏览器/真机环境里走完整 UI，不把本地 HTTP smoke 当作替代证据。

1. 准备：启动 runtime + web，打开已有或临时 workspace，确认 topbar `Memory` 入口可见且 drawer 可开关。
2. Active tab：通过 CLI 或 API 预置一条 active memory，打开 Memory drawer，确认条目出现；展开后能看到 source evidence、actor snapshot、updated/injected 信息。
3. Candidate tab：用 worker 身份新增一条 candidate memory，确认 Candidate tab 显示；点击 approve 后进入 Active，另建 candidate 点击 reject 后进入 Rejected/不再出现在 Candidate。
4. Archived tab：从 Active archive 一条 memory，确认 Active 消失、Archived 出现，且 startup/recovery/dispatch 注入不再使用该条。
5. Settings：切换 Memory injection 总开关，确认关闭时 startup/recovery/dispatch 和 manual Dream run 都被阻止；恢复开启后功能正常。
6. Dispatch observation：发起一次包含相关任务文本的 dispatch，确认 payload 中有 `<hive-memory context="dispatch">`，UI dispatch 详情能列出本次注入的 memory。
7. Dreams tab：点击 Run now，确认 run history 出现 completed/failed 状态、diff report 可读；对 completed run 点击 Revert，确认 run 状态变为 reverted，新增 memory 被 archived、被改写条目恢复。
8. Mobile/remote：在手机浏览器通过远程 relay 打开同一 workspace，重复打开 Memory drawer、查看 tabs、Run now/Revert 按钮状态；确认没有假设 gateway 直接代理 `/api/*`。
9. 证据：记录浏览器/设备、workspace id、关键截图或短视频、是否通过；失败项写明实际 UI 文案、console/network 错误、复现步骤。

## Self-Review

### Round 2 reviewers（current worktree）

- A 架构与可维护性：B-。严重项：`WorkspaceMemoryDrawer` 754 行仍偏厚；中等项：`runtime-store-helpers.ts` composition 继续膨胀、Dream stale recovery 只在 scheduler 路径。
- B 真实 bug 与边界：B-。高风险项：DB 中已有 fresh `running` Dream row 时手动 Run now 仍可再开；中等项：Dream CLI stdout/stderr 无上限、digest/audit 失败是 best-effort 降级。
- C 测试质量：B-。无新增 node-pty mock/test-only fallback；中等项：Dream CLI argv 校准盲区、digest/audit DB 失败缺真集成；既有 `ship-bundle` 生成代码字符串断言仍是测试债。
- D spec 对齐：B。无协议严重偏离；指出 research 文档旧句包含 `status`，与实施 plan 的 `user_input/send/report` 白名单冲突。

### Verdicts

- 修：mixed system messages 进入 Dream prompt。证据：`team-memory-dream-run-store.ts` 统一过滤 `user_input/send/report`；`team-memory-dream-runner.test.ts` mixed window 覆盖。
- 修：damaged `dream_runs.report` 拖垮 history/export。证据：Dream JSON parse 容错为 `null`；history/export damaged report 测试覆盖。
- 修：deleted workspace pending export close 时重复报错。证据：export flush 在 workspace path 解析失败时清 pending no-op。
- 修：stale `running` Dream row 阻塞 scheduler/history。证据：`team-memory-dream-run-store.ts` 的 stale normalization 被 `getScheduleState()`、`listRuns()`、`getRun()` 复用；新增 scheduler 与 UI history stale recovery 测试。
- 修：DB 中已有 fresh `running` Dream row 时手动 Run now 可重复开启。证据：`createRun()` 在事务前 stale-normalize 后拒绝现存 running；新增 `manual trigger returns 409 when the database already has a fresh running run`。
- 修：Dream op source 可引用 system/旧消息。证据：applier 只接受本 run 输入窗口内 `user_input/send/report` sequence；新增 system source 拒绝测试。
- 修：research 文档与实施 plan 的 Dream 输入白名单冲突。证据：research spec 已改为只读 `user_input/send/report`，明确 `status` 不触发阈值也不能作为 citable source。
- 修：v25 recall FTS 每次 runtime 启动无条件 rebuild。证据：`sqlite-schema-v25.ts` 增加 table/sample health probe，只在缺表或索引失配时 rebuild；`schema-version.test.ts` 覆盖 unhealthy repair 与 healthy no-rebuild sentinel。
- 修：`team-recall-api.test.ts` 缺正向 HTTP 用例且错误路径精确断言文案。证据：新增真实 HTTP 正向用例同时召回 message + dispatch evidence；错误路径保留 status 和 error shape，不再绑定具体 error message。
- 不修：UI drawer/exporter/services composition 偏厚。理由：当前硬上限未破，功能已纵切完成；M+1 可拆 `DreamsTab`/memory hooks/export renderer，不混入本次交付。
- 不修：双 daemon 共用 DB、并发 revert 重叠 prior state、Dream CLI stdout/stderr 无上限。理由：当前产品运行模型是单本地 runtime；风险已记录，后续 schema hardening/provider bridge 再处理。
- 不修：digest/audit 失败走 best-effort 降级。理由：startup/recovery/dispatch 记忆不可阻断核心协议；dispatch 写入路径已有失败回滚测试，后续可补 DB 故障真集成来证明“不注入半截 memory + 不污染 audit”。
- 不修：既有 `tests/unit/ship-bundle.test.ts` 生成代码字符串断言。理由：不是本轮 memory 代码引入；作为测试债记录，后续 gateway/package 测试清理时处理。
- 不修：UI Run/Revert 行为测试和真机人工走查。理由：当前 AGENTS 临时模式允许 UI 以 build/人工反馈为主；本次已用 API 集成测试覆盖核心行为，HITL UI 走查仍单独列为未完成。

综合评分：B-。M1/M2 代码路径已实现并通过全量闸门；剩余风险集中在 M+1 重构、双 runtime hardening、Dream CLI 输出上限、UI 人工走查。

## 潜移默化改造（M1.5，2026-06-08 grilling 定稿）

目标：把已落地的 M1+M2 从「偏显式」推到「潜移默化 / 零心智负担」。决策见 spec「Ambient Experience Decisions (2026-06-08)」8 条。下面只列**相对当前实现的 delta**（纵切，每条独立可验，非 UI 部分按 §三补真集成测试）。

| # | delta 任务 | 改动面 | 验收 |
|---|---|---|---|
| A1 | **砍 worker 直写**：`memory_add` 移出 WORKER_COMMANDS；worker startup 提示去掉 add 引导；worker add 请求返回 403 | `team-authz.ts`、worker 提示拼装、`routes-team-memory.ts` | worker `team memory add` → 403；orch 仍 →active |
| A2 | **candidate 退场**：dream→active 已是现状；UI 去掉 Candidate tab；`status='candidate'` 列保留但默认无产出方 | `WorkspaceMemoryDrawer.tsx`、相关 UI api | 面板无 Candidate tab；无 candidate 产生路径 |
| A3 | **dream 节奏改 idle+floor**：触发条件从「每日+≥20+无working」改为「无working agent + debounce + 最小间隔 floor(~15-30min) + 有新 report 即可」，daily 保留兜底 | `team-memory-dream-scheduler.ts` | 集成测试：idle 后触发、floor 内不重复触发、有新 report 即达阈值、working 时不触发 |
| A4 | **注入 recency 软衰减 + confidence 门**：dispatch 排序加 recency 衰减因子（显式>dream 仍为第一键）；dispatch 只推 `confidence≥阈值`，低置信不推但 recall 仍可拉 | `team-memory-digest.ts`、`team-memory-injection.ts` | 单测：久未复证条目排序下沉；低置信不进 dispatch、能被 recall 命中 |
| A5 | **dream 矛盾取代（supersession）**：dream prompt + ops 支持「新证据与旧条目矛盾 → archive 旧条目」；判据用协议证据非 agent 自评 | dream prompt、`team-memory-dream-ops.ts`/`-applier.ts`（archive op 已有，补矛盾识别语义） | 集成测试：喂入矛盾的新 report → 旧条目被 archive、新条目 active |
| A6 | **orch 内联 add 高精度化**：orch startup 提示改为保守/evidence-gated/先查重/「没什么值得记就不记」，反 Hermes 激进偏置 | orch 提示拼装 | 真机 dogfood 校准：orch 不滥 add、空结果是常态 |
| A7 | **确认完全静默**：核查无 toast/红点/计数；面板纯审计、任何主链路不依赖它 | UI 走查 | 无主动推送；关 memory 后派单无 `<hive-memory>` |

实施状态（2026-06-08）：

- [x] A1：worker `team memory add` 在真实 HTTP / CLI 路径返回 403；orchestrator add 仍直接写 active；worker startup / protocol guidance 不再引导 add。
- [x] A2：Memory drawer 去掉 Candidate tab 和 candidate 审核按钮；`status='candidate'` schema/API 保留作历史兼容与未来 opt-in review mode。
- [x] A3：Dream scheduler 改为 idle debounce + minimum floor；默认 pending 输入阈值降为 1，worker report 后可在 workspace idle 时分钟级触发，working/running/disabled gate 保留。
- [x] A4：dispatch memory digest 加 `confidence >= 0.5` push 门；同 source/confidence 下对旧 `updated_at` 加 recency soft-decay penalty，低置信条目仍保留在 search/recall 拉取通道。
- [x] A4 reviewer fix：`team recall` 合并 active `memory_entries` 搜索结果，返回 `source_type="memory"` 和 memory 审计字段；低置信 memory 不进 dispatch push，但可通过真实 HTTP/CLI recall 拉取。
- [x] A5：Dream prompt 明确 supersession：新 protocol evidence 与 active memory 矛盾时 add/rewrite 新事实并 archive 旧条目，不让冲突条目并存；现有 archive op/applier 覆盖落地。
- [x] A6：orchestrator startup / protocol guidance 改为 high-precision inline add：先 `team memory search` 去重，仅保存 rare/evidence-backed/cross-session durable insight，并明确 nothing worth saving is normal。
- [x] A7：Topbar Memory 入口保持静默审计入口，无 badge/count/learned/candidate 提示；memory workspace 开关关闭时真实 dispatch 合约不写 `<hive-memory>`、不写注入审计、也不更新 `last_injected_at`。
- [x] Final gate：§4 四 reviewer 自评后修复 blocking findings；最终 `pnpm check && pnpm build && pnpm test` 通过（336 files：335 passed + 1 skipped；2176 tests：2173 passed + 3 skipped）。

依赖：A1→A2（砍直写后 candidate 自然无产出）；A4 依赖现有 digest 排序；A3/A5/A6 相互独立可并行。M1.5 交付仍按 §五全量闸门 + §4 四 reviewer 自评。

### M1.5 post-review 收尾（2026-06-08，TDD）

第二轮 reviewer（B/B+/A）后，按"生产完整 + 潜移默化 + 不烧配额"标尺收掉四处遗留：

- **#3 pinned 在 dispatch 也豁免衰减**：`team-memory-digest.ts` dispatchRank 加 `pinnedRank` 为第一排序键，pinned 条目免 recency 衰减、绕过 confidence 门（仍须 active 且未 disabled）。让"pin = 永远露出"在 startup/recovery/dispatch 三处语义一致——零操作 ambient 系统里 pin 是用户唯一的显式控制手段。新增 2 个单测（pinned 排首+绕门、disabled pinned 仍不推）。
- **#2 dream poison-pill 指数退避**：`team-memory-dream-run-store.ts` getScheduleState 计 `consecutiveScheduledFailures`（上次成功后的 scheduled 失败数）；`team-memory-dream-scheduler.ts` effectiveFloor = floor × 2^min(max(0, failures−1), 5)。**第一次失败仍 1x floor 立刻重试**（transient 抖动快速恢复，保住既有"failed window 重试"语义），**第二次起翻倍**，最慢 ~10.6h，成功即归零。封住"~72 次失败 CLI/天"的配额漏，且永不丢窗口。新增 1 个集成测（连续失败退避、过退避floor仍重试）。
- **#1 删死 daily 兜底**：`DREAM_SCHEDULER_DAILY_MS` 在 `sinceLastScheduled < floorMs && < dailyMs` 里是恒真死代码（floor 永远 < daily）。cadence 实际就是 idle + floor，删掉误导参数与死分支。
- **#4 合并重复函数**：`latestRunSeqTo` 与 `latestInputSeqTo` reviewer 修复后逐字相同 → 合为 `latestConsumedSeq`，`inputWindow` 去掉无意义的 trigger 分支。

验证：tsc 0、biome 0、memory/recall/dream/schema 子集 111 绿（含新增 3 测），全量回归闸门见文末。

## 风险与对策

| 风险 | 对策 |
|---|---|
| idle 触发 + 低 floor 导致 dream 跑太勤烧配额 | 最小间隔 floor + 有新 report 才跑 + 无 working agent 才跑；floor 值 dogfood 校准 |
| recency 衰减把「半年前的真理」误沉 | 软衰减（降排序权重）非硬归档；pinned 永不衰减；supersession 才真归档 |
| confidence 门把有用但低置信条目挡在 dispatch 外 | 阈值保守 + 低置信仍可被 `team recall` 拉到（高召回 pull 通道兜底） |
| 砍 worker 直写后 worker 的即时发现无处可去 | worker 照常 `team report`，dream 提取 + orch 内联 add 覆盖；同会话靠 orch 本职 |
| FTS backfill 在大 messages 表上慢 | 迁移内分批 insert；本地库量级实测 |
| trigram tokenizer 需 SQLite ≥3.34 | better-sqlite3 自带新版 SQLite，迁移前断言版本 |
| dream headless CLI 输出不是干净 JSON | 严格 parse + 提取首个 JSON 块；失败= run failed，不部分应用 |
| 注入污染派单语义 | 预算硬上限 + "verify before relying" 措辞 + 显式>dream 排序 |
| dream 在用户工作时抢 CLI 并发/配额 | 仅 idle 触发 + 每日一次 + 手动可关 |
| memory.md 被用户手改后丢失 | 文件头声明 generated；导出前 diff 检测到非导出内容时保留备份副本 |
