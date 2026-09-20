# Windows 兼容性 Bug 审计存档

> 存档日期:2026-05-29
> 方法:两轮多 agent workflow 扫描(find → 对抗式 verify → completeness critic)
> 背景:维护者只有 macOS,无法在 Windows 上测试;线上已有 Windows 用户(刘小明)反馈
> "Workspaces 路径打不开 / 添加成员启动不了 / Orchestrator 启动失败: Failed to fetch"。
>
> 本文档是审计快照,**不随代码自动更新**。落地任何一条前都应重新核对当前代码与 `git log`。

## 状态总览

| 轮次 | 模型 | 确认 | 驳回 | 状态 |
|---|---|---|---|---|
| Round 1(表层 6 维度) | Sonnet | 14 | 2 | **已全部修复**(见下表,1.4.4 发布) |
| Round 2(深层 12 维度) | Opus | 20 | 20 | **全部待处理** |
| Round 3 候选(部分跑完 6/22 维度) | Opus | — | — | **未校验**:25 条 raw finding;workflow 被中途停止,3-lens 对抗校验未运行;落地前必须人工核对 |
| Round 4(R3 未覆盖的 16 维度) | Opus | 17 | 18 | **部分已处理**;#47 已修 `bd117d7` + #18 回归测试;其余待处理。已经 3-lens 对抗校验(机制 / 可达性 / 当前代码各一票,≥2 票 REAL 才确认) |

Round 2 维度:文件锁/原子写、ConPTY 运行时、SQLite/Drizzle、网络双栈、文件监听、
team CLI 往返+env 注入、sandbox 越权、路径身份/去重、spawn env 大小写碰撞、崩溃恢复,
外加 2 个端到端子系统审计(spawn→PTY→kill→restart 全链、workspace-add→validate→autostart 全链)。

校验来源说明:Round 2 每条经 1 个对抗式 verifier(三视角合一:可达性 / OS 机制正确性 /
git 历史+去重)判定 REAL,默认从严 refute。这是"对抗校验过一次",非"逐行复核",
落地前仍需人工确认。

Round 3 已覆盖维度(6):reserved-names-invalid-chars、cmd-parser-deep、workspace-shell-runtime、
long-paths、native-deploy-pack、process-tree-kill-signals。
Round 3 **未覆盖维度(16,workflow 中止前未跑):** powershell-quoting、PATHEXT-exec-resolution、
newline-encoding-IPC、node-pty-ConPTY-spawn、SQLite-Windows、filewatch-edge-cases、AV-defender、
network-host-CORS、web-client-Windows、env-case-collisions、editor-open-explorer、
session-resume-windows、E2E-add-workspace-flow、workflow-runtime-windows、
database-migration-windows、crash-handlers-R2-extension。

---

## Round 1 —— 已修复(14 confirmed)

| 问题 | 文件 | 修复 commit |
|---|---|---|
| PowerShell picker 未设 `[Console]::OutputEncoding=UTF8`,中文路径乱码 | `src/server/fs-pick-folder.ts` | `9d2c932` |
| Gemini `.project_root` 大小写敏感比对 | `src/server/session-capture-gemini.ts:45` | `bf90d2e` |
| `getGeminiHome` 硬编码 `'/tmp/'` POSIX 标记 | `src/server/session-capture-gemini.ts:16` | `bf90d2e` |
| Codex session cwd 大小写敏感比对 | `src/server/session-capture-codex.ts:95` | `8737309` |
| `getCodexHome` 硬编码 `'/sessions/'` POSIX 标记 | `src/server/session-capture-codex.ts:18` | `8737309` |
| cmd.exe "命令找不到"退出码 9009 未识别(只认 127) | `src/server/orchestrator-autostart.ts` | `92d5458` |
| `resolveDataDir` 用 `~/.config/hive` 而非 `%APPDATA%` | `src/cli/hive.ts` | `83c438c` |
| `appendTask` 硬编码 LF,破坏 CRLF 的 tasks.md | `web/src/tasks/useTasksFile.ts` | `2f8b47e` |
| 粘贴路径未剥 Explorer "复制为路径"的引号(Confirm 对话框) | `web/src/workspace/ConfirmWorkspaceDialog.tsx` | `0235c1b` |
| 同上(ServerBrowse 对话框)+ 面包屑分隔符硬编码 `/` | `web/src/workspace/ServerBrowseDialog.tsx` | `5958260` |
| `looksLikePath` 只识别 `/`,漏 Windows 反斜杠路径 | `web/src/tasks/task-meta.ts:72` | `a2677bf` |
| `hive update` npm prefix 含空格被截断 + 信号转发孤儿 npm | `src/cli/hive-update.ts` | `e8d4325` |
| OS picker 输出被重复 sandbox 校验(非 home 盘/中文路径被拒) | `src/server/fs-pick-folder.ts` `src/server/fs-browse.ts` | `fea2e34` |

Round 1 驳回(2,均为无真实触发条件):

- `src/server/session-capture-opencode.ts:57` SQL binary collation —— 两侧同源 `realpathSync`,无分叉。
- `src/server/tasks-file.ts:52-54` PROTOCOL.md 写 LF —— `.gitattributes` 强制 `eol=lf` 且是生成文件。

---

## Round 2 —— 待处理(20 confirmed)

### HIGH(7)

#### 崩溃簇 —— 极可能是刘小明 "Failed to fetch" 的根因

这一类的共性:Windows 特有的文件锁/socket 错误 → 未捕获的 rejection/exception → 掀翻整个
runtime → HTTP 响应飞行中断 → 浏览器只见 generic 的 "Failed to fetch"。macOS 不复现是因为
POSIX 无同类锁/socket 语义。**全仓库无 `process.on('uncaughtException')` / `unhandledRejection`
兜底(已核实)。**

1. **PTY 未挂 `error` listener** —— `src/server/agent-manager-support.ts:190-202`
   只挂了 `onData`/`onExit`。Windows 下 node-pty 用 net.Socket 建 conin/conout,ConPTY 初始化
   失败 / conpty.dll 缺失 / 管道断裂时 socket error 被**重新抛出**;spawn 已返回,外层 try/catch
   接不住 → runtime 死。autostart 期间崩即 "Failed to fetch"。(已核实:无 error listener)

2. **`createWorkspace` 里 `void startWorkspaceWatch` 无 `.catch`** —— `src/server/runtime-store.ts:120-124`
   `writeFileSync`/`mkdirSync` 命中受保护目录(Program Files/OneDrive 锁)抛 EPERM,或 UNC 盘
   chokidar 无 error listener → unhandled → runtime 死在 create 响应中途。(已核实:仍 `void`,line 122)

3. **`ensureProtocolFile` 无防护 `writeFileSync`** —— `src/server/tasks-file.ts:48-55`
   每次开 workspace 都可能写;协议文档还教 agent `type .hive/PROTOCOL.md`,别的进程持句柄时
   写抛 EPERM/EBUSY → 同样 unhandled rejection。

4. **tasks.md `readFile` 只吞 ENOENT,其余 re-throw** —— `src/server/tasks-file-watcher.ts:66`
   在 `setTimeout` 里 `void` 调用。Windows 文件共享冲突(EBUSY/EPERM)→ 未捕获 rejection → 死。

> **统一修复**:`src/cli/hive.ts` 加 `process.on('uncaughtException')` + `unhandledRejection`
> 全局兜底;给 PTY 挂 error listener(路由进现有 exit 路径);给 `void` 的 watch 调用补 `.catch()`;
> 对 EPERM/EACCES/EBUSY 做短重试。一个 hardening pass 同堵 4 个崩溃口,且最可能直接修好线上 "Failed to fetch"。

#### 其它 HIGH

5. **`atomic:100` 在 Windows 上其实无效** —— `src/server/tasks-file-watcher.ts:35,86`
   推翻了 Round 1 的 commit `f91796f`。deep agent 读 chokidar 源码论证:单文件 watch 不监听父目录、
   句柄重绑被 `(isMacos||isLinux||isFreeBSD)` 显式排除 Windows → 外部编辑器原子保存后 watch 永久失聪。
   **落地前必须实测当前安装的 chokidar 版本行为,不可盲信。** 修法:改为监听父目录并过滤 tasks.md,
   或对 tasks watcher 开 `usePolling`(它只盯一个小文件,代价可忽略,同时解掉 #10/#20)。

6. **`validateWorkspacePath` 用非 native `realpathSync`,不规范化 Windows 大小写** —— `src/server/workspace-path-validation.ts:13`
   `C:\Projects\App` 与 `c:\projects\app` 被当两个 workspace(表无 UNIQUE 约束)→ 同一目录裂成
   两份状态/历史/session。(已核实:line 13 仍是普通 `realpathSync`)
   修法:改 `realpathSync.native`(ENOSYS 回退);create 前按 win32 大小写不敏感查重。

7. **Windows Ctrl-C(退出码 3221225786)被当崩溃,永久删 resume session 指针** —— `src/server/agent-run-exit-handler.ts:14`
   `clearResumedSessionOnFailure` 以 `exitCode !== 0` 判失败。Windows 下 Ctrl-C 是 `STATUS_CONTROL_C_EXIT`
   (0xC000013A,非 0)→ 删掉 `--resume` 指针 → 下次 Restart 降级到 Layer B。
   修法:加 `isUserInterruptExit(code)`(含 null/130/143/3221225786),在删除前 gate。

### MEDIUM(8)

| # | 文件 | 问题 | 修法要点 |
|---|---|---|---|
| 8 | `src/server/tasks-file.ts:64-67` | `writeTasks` 非原子 + 无重试;Windows 锁冲突 → 500 → UI 静默回滚用户编辑;崩在写一半把 tasks.md 截空并广播 | 同目录 temp + fsync + rename 重试(勿用 os.tmpdir 跨盘 EXDEV) |
| 9 | `src/server/agent-manager-support.ts:74` | 用户主动 Stop 在 Windows 被误判为崩溃(`taskkill /F` → 非 0)→ 丢 resume session | stop 时记 `userRequestedStop`,exit 分类时视为 clean |
| 10 | `src/server/tasks-file-watcher.ts:86` | 网络盘/UNC/映射盘 watcher 静默永不触发(ReadDirectoryChangesW 不支持远程盘,从没设 usePolling) | 非本地根开 usePolling |
| 11 | `src/cli/team.ts:275` | `team report --stdin` 按 UTF-8 解码、不剥 BOM、不处理代码页;而这正是文档教 Windows agent 用的通道 → 非 ASCII 汇报必乱码并灌进 orchestrator | 剥 BOM;文档改 `chcp 65001` / `Get-Content -Raw -Encoding utf8` / 优先 `< file` |
| 12 | `src/server/fs-browse.ts:90-105,146` | FS-browse sandbox 纯词法判断(无 realpath)→ `$HOME` 内 Windows junction/符号链接越权列出沙箱外内容 | 校验前 `realpathSync.native` 再判 `isPathWithinRoot` |
| 13 | `src/server/tasks-file-watcher.ts:86` | #6 连锁:两个大小写变体 workspace → 两个 watcher 盯同一物理 tasks.md → 跨 workspace 事件串台/双发 | 从源头(#6 去重)解决 + watcher canonical 去重 |
| 14 | `src/server/agent-run-sync.ts:22,54` | `exitCode===0?'exited':'error'` 把 Windows Ctrl-C(3221225786)持久化成 `error`,污染恢复历史(#7 同源) | 统一 exit-code 分类器 |
| 15 | `src/server/agent-manager-support.ts:13-15,49,125,150` | kill 路径用同步 `execFileSync('taskkill')` 阻塞事件循环;关闭时串行 N 个阻塞 spawn,期间 server 冻结 | 改异步 execFile/spawn detached |

### LOW(5)

| # | 文件 | 问题 |
|---|---|---|
| 16 | `src/server/agent-manager-support.ts:167-169` | agent 退出后 `resize()` 在 ConPTY 抛错(POSIX 静默)→ 退出恰逢窗口 resize 时 UI 闪红色错误条 |
| 17 | `src/server/marketplace-store.ts:100-127` | marketplace `readAgent` 路径校验纯词法 → junction 可读沙箱外任意 `.md`(需写安装目录,门槛比 #12 高) |
| 18 | `src/server/routes-settings.ts:40` | preset "可用"徽章在 `Path`/`PATH` 大小写碰撞时查错 key → CLI 实际可用却显示红 |
| 19 | `src/server/agent-command-resolver.ts:91-94,147-159` | `.ps1` 命令能解析但无法启动(CreateProcess ENOEXEC),只重打包了 `.cmd`/`.bat` |
| 20 | `src/server/tasks-file-watcher.ts:86-101` | UNC 盘 chokidar 可能永不 ready(awaited promise 永久挂起)或抛未处理 'error' |

---

## Round 2 —— 驳回(20,对抗校验判定 NOT_REAL)

记录在案以免日后重复纠结。多数是"机制不成立 / 非 Windows 特有 / 仅手工构造可触发 / 推测性 AV 竞态 / 纯诊断增强"。

| 标题(摘) | 文件 | 驳回理由(摘) |
|---|---|---|
| `ensureTasksFile` 首读无防护写 | `tasks-file.ts:29-39` | 有 existsSync 守卫,create-only,agent 启动前无锁竞争 |
| SQLite rollback-journal AV EBUSY | `runtime-database.ts:8-17` | 推测性 AV 竞态;现代 AV share-delete;busy_timeout 也救不了 DELETE |
| PTY 无 cols/rows → 80 列硬折行 | `agent-manager.ts:115-119` | mirror 也是 80 列,无分叉;纯 cosmetic |
| WS resize 接受 0/负值 | `terminal-protocol.ts:25-32` | 非 Windows 特有;仅手工构造客户端可触发 |
| better-sqlite3 无 Windows prebuild 保证 | `package.json` | 12.9.0 的 prebuild 实际覆盖 win32-x64/arm64 |
| `%APPDATA%` roaming SMB 上 SQLite 损坏 | `hive.ts:133-150` | 企业级误配 + 单写进程;非常规触发 |
| 两个 hive 实例共享 sqlite | `hive.ts:172-198` | 跨平台问题,非 Windows 特有 |
| 原生 DB-open 失败仅打 bare message | `hive.ts:215-221` | 诊断增强,非功能缺陷 |
| OpenCode DB 只读轮询 WAL 冲突 | `session-capture-opencode.ts:48-67` | SQLite 共享模式 + 只读降级重试已处理 |
| IPv4-only bind,localhost 命中 ::1 | `hive.ts:224` | 浏览器 Happy Eyeballs 回退;真实客户端用 IPv4 字面量 |
| local-request-guard 拒 IPv4-mapped Host | `local-request-guard.ts:5-19` | IPv4-only bind 下该状态不可达 |
| `team.cmd` `%*` 百分号展开破坏正文 | `bin/team.cmd:2` | cmd 不会二次展开被替换进来的文本 |
| `team --stdin` 无管道时永久挂起 | `team.ts:272` | ConPTY 控制台 stdin isTTY=true,守卫照常触发 |
| browseDirectory 处理保留设备名挂起 | `fs-browse.ts:90-117` | 阻塞需第三方故障驱动;残留仅良性 cosmetic |
| `isPathWithinRoot` 误拒 8.3 短名 | `fs-sandbox.ts:20-26` | homedir 始终长格式,不会触发 |
| Claude resume key 大小写分叉 | `session-capture-claude.ts:51` | 同源 realpathSync;字符类问题已由 016a1e5 修 |
| `createSpawnEnv` 清不掉非常规大小写的 NO_COLOR | `agent-manager.ts:54-59` | 无 `No_Color` 的真实来源 |
| [Restart] 竞争 taskkill | `agent-runtime.ts:112-119` | Windows kill 是同步的,曝露面更小而非更大 |
| Windows stop 总是 force-kill 无优雅窗口 | `agent-manager-support.ts:114-131` | 平台约束;改了会重新引入孤儿进程 bug |
| force-kill timer 杀已回收 PID | `agent-manager-support.ts:141-158` | 句柄锁定 PID,跨平台 TOCTOU 而非 Windows 缺陷 |

---

## Completeness Critic —— 两轮都没覆盖的盲区

**最关键(元层面)**:Hive **没有任何真实 Windows CI**,所有 Windows 测试都是注入 `platform`
参数的单元测试 —— 真实的 node-pty ConPTY spawn→解码→resize→tree-kill→restart 整条链**从未在
Windows 上跑过**。一个 GitHub Actions `windows-latest` runner 跑现有 `tests/server` + 一个最小
真实 PTY spawn 测试,能把下面大半盲区从"未探测"转成"已验证"。

1. **SQLite 无 WAL/busy_timeout/synchronous pragma** —— `src/server/runtime-database.ts:8-18`。
   建议 `journal_mode=WAL` + `busy_timeout=5000`。
2. **node-pty 未固定 `useConpty`、spawn 未传初始 `cols/rows`** —— `src/server/agent-manager.ts:115-119`。
   行为随宿主 Win10 版本在 ConPTY/winpty 间漂移。
3. **从 macOS 发版时 node-pty Windows prebuild 是否进 tarball** —— `scripts/postinstall-native-artifacts.mjs`
   只 chmod darwin;需确认 `npm pack` 后 Windows 二进制是否齐全。
4. **WS resize 无下界 clamp** —— `src/server/terminal-protocol.ts:22-27`,`cols:0/rows:0` 直达 `pty.resize`。
5. **`run.output` 环形缓冲截断破坏 post-start prompt/paste-ack 检测** —— `agent-manager-support.ts:193-194`
   与 `post-start-input-writer.ts:100,143`(Windows CRLF + ConPTY 重绘使更易越过 1MB)。
6. **`team.cmd` 的 `isMainModule` 大小写门** —— `src/cli/team.ts:405-407`,盘符大小写不符 → `team report`
   静默退出 0 什么都不干。
7. **`explorer.exe` 启动对非规范分隔符敏感** —— `src/server/open-target-commands.ts:95`,与路径身份弱点(#6)连锁。
8. **workspace "Shell" 终端的 env/身份在 Windows 未审查** —— `src/server/workspace-shell-runtime.ts:186-202`,
   用比 agent 更小的 env 起 cmd.exe,共享 PTY 机制(taskkill/resize)但无测试。

---

## Round 3 候选 —— 未校验(25 candidates,workflow 被中途停止)

> 抓取日期:2026-05-29
> 方法:Workflow 启动 22 个 finder agent,执行 6 个后被用户停止;3-lens adversarial verify **未运行**。
>
> **重要**:下方 25 条全为 finder 单跑输出,未经对抗校验。基于 R2 经验,约 30-50% 可能被驳回。
> 落地任何一条前必须人工核对当前代码与 `git log`,**禁止照搬**。

### HIGH(3 候选)

#### 崩溃簇延伸 —— R2 hardening 之外的两个新崩口

21. **`hive update` Ctrl+C 广播 race 孤儿化 gyp/python 链** —— `src/cli/hive-update.ts:125-140`
    Windows 控制台 Ctrl+C 是 console-group 广播(`CTRL_C_EVENT` 同时投递给该 console 上所有进程),
    不像 POSIX 只投到前台进程组。child 用默认 `detached:false` 与 hive 共享 console,cmd.exe 收到广播
    立即退出 → hive 的 SIGINT handler 跑 `taskkill /t /f <cmd.exe-pid>` 时 cmd.exe 已死,`/T` 枚举不到
    npm/node-gyp/python 后代 → 孤儿。源文件 line 27-33 的内联注释本身就警告这个孤儿场景,但选错了 tree root。
    修法:`spawn(... { detached: true, stdio: 'inherit' })` 让 child 自有 console group,再在父进程 SIGINT
    里 `taskkillProcessTree(child.pid)`。

22. **shutdown 无超时,kill-resistant PTY 子进程无限挂住 runtime** —— `src/cli/hive.ts:247-287`
    `closeAgentRuntime` 里 `await Promise.all(exitEntries.map(e => e.promise))` 无上界。POSIX 上 SIGKILL
    无条件 reap;Windows 上 `TerminateProcess` 命中持有 IRP_MJ_CLOSE 锁的 driver(AV 扫描中 / BitLocker
    indexing / 任何慢 filter driver)时,目标进入 EPROCESS-pending-termination,conout pipe 不 drain
    → node-pty `onExit` 永不触发 → exit promise 永不 resolve → hive 变成同一 console 杀不掉的僵尸
    (用户的 Ctrl+C 已经用掉,line 249 的 `process.off` 已经卸了 handler)。
    修法:`Promise.race` + 5s `forceQuit` 调 `process.exit(1)`;并 re-arm 第二次 SIGINT 立即 exit(1)。

#### 路径身份扩展 —— R2 #6 之外的反向问题

23. **Workflow source 路由接受 Windows 保留名 / 非法路径字符 → 设备打开 / ADS 写入 / 写 NUL 静默丢失**
    —— `src/server/routes-workflows.ts:29-38, 190-214`
    `resolveSafeScriptPath` 只拒 `/` `\\` 并要 `.ts` 后缀。Win32 文件系统层把 `CON / PRN / AUX / NUL / COM1-9 / LPT1-9`
    在**任意路径深度**都视为 DOS 设备名 —— `<ws>\\.hive\\workflows\\NUL.ts` 解析为 NUL 设备,writeFile 静默
    丢字节、返回成功,UI 以为存好了,后续 scanWorkflowScripts 找不到该 workflow。`CON.ts` 把源码流到控制台;
    含 `:` 的文件名打开 NTFS ADS(`writeFile('foo:hide.ts')` 写 `foo` 的 hide 替代流,readdir 只见 `foo`,
    workflow 鬼隐);`? * < > | "` 抛 EINVAL;尾随 `.` 或空格被静默剥离造成 `foo .ts` 与 `foo.ts` 写入碰撞,
    `wx` 标志的 EEXIST 失守。POSIX 全合法路径字节,无对应行为。
    修法:抽公共 sanitize:case-insensitive 拒保留名(含任意扩展,Win32 把 `NUL.ts` 与 `NUL` 等同)、拒
    `<>:"/\\|?*` 与 0x00-0x1F、拒尾随 `.` 或空格;两个路由(`PUT /source` 与 `POST /install-template`)共用,
    单测覆盖 OWASP/MSDN 保留名表。

### MEDIUM(11 候选)

| # | 文件 | 问题 | 修法要点 |
|---|---|---|---|
| 24 | `src/server/workflow-runner.ts:199-213` | 嵌套 `workflow(scriptName)` DSL 仅校验非空字符串,reserved-name / 非法字符 / `..` 段均未过滤,Windows 下 `workflow('nul')` 读 NUL 设备返空,extractMeta 抛混淆错误 | 与 #23 共用 sanitize util;并拒 `..` 段 |
| 25 | `bin/team.cmd:1-3` | 缺 `setlocal DisableDelayedExpansion`;父 cmd 开了 `/v:on` 或 HKCU `DelayedExpansion=1` 时,`%*` 替换进来的用户参数里的 `!var!` 在执行前被静默展开 | 第二行加 `setlocal DisableDelayedExpansion`(MS 对 shim 脚本的推荐默认) |
| 26 | `src/server/open-target-commands.ts:84-103` | `cmd.exe /d /s /c <bin> <path>` 经 libuv `quote_cmd_arg` 只对空白与 `"` 加引号,**不处理 cmd 元字符** `& \| < > ^ ( )`。路径含 `&`(如 `C:\\Users\\Foo&Bar\\code`)且无空白时被 cmd 解析为两条命令 → 打开错位 / 命令注入 | 用 `escapeCmdToken`(已存在于 agent-command-resolver.ts:106-110);或放弃 cmd 包装,JS 内 PATHEXT 解析后直 spawn `.cmd`(Node 22+ 已支持) |
| 27 | `src/cli/hive-update.ts:64-77` | 与 #26 同源:`planSpawnInvocation` 为绕 CVE-2024-27980 包了 `cmd.exe /d /s /c`,但 cmd 元字符仍不转义。npm 安装前缀含 `&`(账户 `Foo&Bar`)即被裂成两条命令 | 同 #26 复用 `escapeCmdToken`;或直 execFile `.cmd` |
| 28 | `src/server/workspace-shell-runtime.ts:31-39, 186-202` | cmd.exe 启动时检测到 UNC cwd(`\\\\server\\share\\…`)会打印 'CMD does not support UNC paths…' 并悄悄切到 `%SystemRoot%`。CreateProcessW 本身成功,拒绝发生在 cmd 初始化里。同样波及所有走 `buildWindowsBatchCommandLine` 的 `.cmd` agent launcher | UNC cwd 时用 `pushd "<unc>"` 建临时盘符再 cd;或校验阶段拒 UNC 给出明确错误 |
| 29 | `src/server/fs-pick-folder.ts:62, 194-208` | AppLocker / SRP / WDAC / McAfee Application Control 拒 powershell.exe 启动 → ERROR_ACCESS_DENIED → EACCES。picker 只识别 ENOENT,其它 spawnError 经 line 62 `child.exitCode ?? 0` fall-through 当 `canceled` | 在 ENOENT 分支后处理任意非 null `spawnError`,返回带 code 的明确错误并提示用 paste-path |
| 30 | `src/server/workspace-path-validation.ts:12-23` | 默认 `realpathSync`(JS 层)命中 MAX_PATH=260 抛 ENAMETOOLONG;catch 一律改写为 'Workspace path does not exist' | 切 `realpathSync.native`(`GetFinalPathNameByHandleW`,长路径友好);按 `error.code` 分支,ENAMETOOLONG 单独提示 |
| 31 | `src/server/routes-workflows.ts:169-208` | `<ws>/.hive/workflows/<file>.ts` 拼接无总长度预算;workspace 深 200+ 字符时即破 260 → CreateFileW 返 ENAMETOOLONG → 未捕获的 500 | resolve 阶段拒过长拼接;catch 内 ENAMETOOLONG 转 400 带可操作提示 |
| 32 | `src/server/workflow-script-loader.ts:154-160` | `readdir` 只吞 ENOENT;ENAMETOOLONG(长路径)与 EACCES(junction / 继承 ACL)直接 re-throw → 整个 workflows drawer 500 | 一并吞 ENAMETOOLONG / EACCES,返回 `[]` 并通过 `ScannedWorkflow.error` 透传提示 |
| 33 | `scripts/postinstall-native-artifacts.mjs:5-33` | 唯一的 postinstall 钩子只 chmod darwin spawn-helper,**未验证 Windows 必需的** `prebuilds/win32-*/conpty/{conpty.dll, OpenConsole.exe}`、`winpty-agent.exe` 是否就位。当 node-pty 自带 post-install 被 pnpm 10 默认 `onlyBuiltDependencies` 或 corp `--ignore-scripts` 跳过时,文件缺失但安装成功 → 首次 PTY spawn `LoadLibraryW("conpty.dll")` 返 ERROR_MOD_NOT_FOUND → 同步抛 → 触发 R2 HIGH #1 | win32 stat-check 这些产物;缺失则从 `<node-pty>/third_party/conpty/<ver>/win10-<arch>/` 内联复制(等价 node-pty 自己的 post-install.js),或大声失败建议 `npm rebuild node-pty` |
| 34 | `src/server/agent-manager-support.ts:13-15, 42-54` | `execFileSync('taskkill', …)` 无 `timeout`,libuv 全程阻塞。taskkill `/t /f` 通过 WMI 枚举进程树;一旦 vendor driver / Defender / 卡死 ETW session / 阻塞的 conhost provider 拖住任一节点,event loop 数秒到数分钟完全冻结。R2 #15 提了同步性,本条是正交的"无上界" | 切异步 `execFile({ timeout: 3000 })` + kill fallback;或非阻塞 `spawn` + Promise 包装 |
| 35 | `src/server/tasks-websocket-server.ts:94-100` | `socket.close()` 而非 `.terminate()`,与 `terminal-ws-server.ts:74-75` 故意走 terminate 的注释('a polite close would wait on the remote and re-introduce the hang')相悖。Windows 上浏览器突挂(休眠/电源策略/Edge crash)时 TCP 对端 RST 延迟到达,close-frame 进入 30s closeTimeout 等待,wss 不释放 → libuv loop 保活 → `app.server.close()` 已返但进程不退 | 改 `terminate()`,对齐 terminal-ws-server;split 时的对称性漏写 |

### LOW(11 候选)

| # | 文件 | 问题 |
|---|---|---|
| 36 | `src/cli/hive.ts:305-307` + `src/cli/team.ts:509-511` | `isMainModule` 用非 native `realpathSync`,长 install 路径上模块顶层抛 ENAMETOOLONG → hive/team 在打印任何错误前死。修法:`realpathSync.native` + try/catch fallback `false` |
| 37 | `scripts/clean-build.mjs:3-5` | `rmSync` 无 Windows 重试。Defender 实时扫描 / 编辑器 / tsc/vite 持有句柄无 FILE_SHARE_DELETE 时抛 EBUSY/EPERM。`pack-smoke.mjs:18-23` 已用 `maxRetries:20, retryDelay:100`,本处漏 |
| 38 | `scripts/prepare-build-artifacts.mjs:14, 24` | `copyFileSync` / `cpSync` 同样无 Windows 重试与显式 `force:true`;dist 旧文件被任一句柄锁住即整次构建失败 |
| 39 | `scripts/pack-smoke.mjs:90-99` | `spawn(hiveBin, ['--port','0'], { shell: process.platform === 'win32' })`;tempDir 含空格(Windows 账户显示名常带空格,如 `First Last`,tmpdir 即继承)时 cmd.exe 词分裂 → hive.cmd 找不到,smoke test 以混淆错误失败 → 掩盖真正的发版阻塞 bug |
| 40 | `package.json:29-44, 48-50` | `files` 只 ship `bin/team`(POSIX)与 `team.cmd`,**无 `team.ps1`**。PowerShell 用户(尤其设了 `$env:PATHEXT='.exe'` 的硬化配置 / Windows Terminal 默认 PS profile)的 worker 在 PTY 内调 `team` 时,跨 PS→cmd→node 边界存在 `$LASTEXITCODE` 与 unquoted args 怪异。修法:出 `team.ps1` shim |
| 41 | `scripts/prepare-build-artifacts.mjs:15, 28` | `chmodSync(target, 0o755)` 在 Windows 只动 read-only 位,与"执行权"无关;`team` 不在 package.json `bin` 故 npm 也不会生成 shim。Git Bash 经 MSYS 仿真权限表 + 扩展白名单时,首次安装的 dist/bin/team 处于边缘非可执行态。建议 Windows 上只 ship `team.cmd`(平台分支删 dist/bin/team) |
| 42 | `src/server/fs-browse.ts:70-85` | `execFileP('git', …, { timeout: 800 })` 超时 → `child.kill('SIGTERM')` → Windows 上 TerminateProcess 只杀 git.exe;`git-credential-manager.exe` / `ssh.exe` 这些被 Git for Windows 直接 spawn 的辅助进程留作孤儿(Win32 无原生 process group)。修法:`detached:true` + `taskkillProcessTree` |
| 43 | `src/server/fs-pick-folder.ts:189-193` | `execFile('powershell.exe', …)` **缺 `windowsHide: true`** → conhost 闪 50-250 ms 才被 FolderBrowserDialog 盖住(R1 z-order 修了 dialog 被遮,没修 conhost 闪屏) |
| 44 | `src/server/open-target-commands.ts:84-107, 160-173, 252` | cmd.exe shim 包的 VSCode/Cursor/Zed 同样 **缺 `windowsHide`** → 每次"Open in editor"闪一下控制台 |
| 45 | `src/server/tasks-file-watcher.ts:71-81` | `watcher.close()` 内部走 `CancelIoEx` + `CloseHandle`;UNC / 映射盘在 SMB 不可达时(VPN 掉 / sleep+wake 换网)`CancelIoEx` 阻塞到 SMB redirector 超时(默认 ~45 s)→ shutdown 挂住。R2 #20 是 `ready` 挂,本条是 `close` 挂。修法:`Promise.race` 加 2s 超时;非本地路径转 polling(与 R2 #10 对齐) |

### Round 3 续跑提示

- 16 个 finder 维度未运行(见状态总览的"未覆盖维度"列表);adversarial verify 完全未跑。
- workflow script 保留在 `wf_fc6ab748-fe1`(transcript dir 下),可 resume 续跑 verify + 完整性 critic + R2。
- 建议:落地任何一条前先重新 finder 单 lens 校验,或人工逐条核对当前 `git blame` 与代码状态。

---

## Round 4 —— 已校验(17 confirmed)

> 抓取日期:2026-05-29
> 方法:补跑 R3 漏掉的 16 个维度(PATHEXT-exec-resolution、node-pty-ConPTY-spawn、filewatch-edge、
> network-host-CORS、web-client-windows、editor-open-explorer、session-resume-windows、
> e2e-add-workspace、workflow-runtime-windows、crash-handlers-extension 等)+ 对每条 raw finding
> 跑 3-lens adversarial verify(机制正确性 / 可达性 / 当前代码状态各一票),≥2 票 REAL 才确认。
>
> 落地任何一条前仍需重新核对 `git log` —— R2/R3 已发布的修复可能让某些条目失效。

### HIGH(5)

#### Crash 簇延伸 —— R2 #1-4 + R3 #21-22 之外的三个新崩口

R2 已点名"全仓库无 `uncaughtException`/`unhandledRejection` 兜底"。R4 找到 boot 阶段、WS 升级阶段、
chokidar `error` 事件三处独立崩口,**都在 HTTP listener bind 之前/之外触发,所以浏览器永远只见
"Failed to fetch"**,与刘小明症状完全吻合。修法上 R2 提议的全局兜底 handler 能接住残余,但每条
还需要事件级 listener 以保留 workspace/socket context 做自愈。

46. **boot 时 `void tasksFileWatcher.start` 无 `.catch`,EPERM/EBUSY 在 HTTP listen 之前掀翻进程**
    —— `src/server/runtime-store-helpers.ts:97-101, 198`
    `startExistingWorkspaceWatches` 遍历持久化的每个 workspace 并 `void tasksFileWatcher.start(...)`。
    `start` 同步调 `ensureTasksFile` + `ensureProtocolFile`,二者都 `writeFileSync` 到 `<ws>/.hive/`。
    Windows 命中 OneDrive Files-On-Demand placeholder / Defender 扫描 PROTOCOL.md / ACL 拒写 / BitLocker
    睡眠后锁定 → 同步抛 EACCES/EBUSY → async 函数中的同步 throw 变成 unhandled rejection → Node 22 默认
    `--unhandled-rejections=throw` → 进程在 `app.server.listen(port)`(hive.ts:224)**之前**退出非零 →
    浏览器下次 fetch 见 TCP RST。R2 #2 只补了 `runtime-store.ts:181`(用户动作时的 create 路径),boot
    遍历路径未补。
    修法:`.catch(error => log)` 至少不掀进程;更好的是把整个 `startExistingWorkspaceWatches` 改成
    `await Promise.allSettled(...)` 并**移到 `app.server.listen()` 之后**调用 —— watcher 失败仍能起服务。

47. **WebSocket upgrade / established WS error 路径缺 handler** —— **已修** `bd117d7`
    —— `src/server/terminal-ws-server.ts:35-41, 82-115`(同型 bug:`tasks-websocket-server.ts:17-23, 46-91`)
    `rejectUpgrade` 直接 `socket.write('HTTP/1.1 ${status}\r\n\r\n'); socket.destroy()` 无 try/catch;
    upgrade 回调进入时也不挂 `socket.once('error', noop)`。三个 `WebSocketServer({ noServer: true })`
    实例(ioWss、controlWss、tasks wss)同样没挂 `wss.on('error', ...)`。Windows 下浏览器硬杀 / 睡眠 /
    VPN drop 时 Winsock 投递 WSAECONNRESET 比 POSIX 更激进 —— 如果 token 已过期触发 401 reject 路径,
    或 raw socket 已半关闭,async 的 'error' 事件无 listener 即被 EventEmitter 重抛 → uncaughtException →
    进程死。401 reject 路径非常容易碰到(任何过期 cookie 或刷新都走),竞态窗口在 loopback 上虽窄但
    真实。
    修法:(a)`rejectUpgrade` 内 `try { socket.write(...) } catch {}; socket.destroy()`;
    (b)upgrade handler 入口立刻 `socket.once('error', () => {})`;
    (c)三个 wss 各挂 `.on('error', logErr)`;(d)R2 全局 handler 作 belt-and-suspenders。
    状态:`bd117d7` 已补 raw socket / wss / established WebSocket 三层 handler;#18 的
    `WS_ERR_UNEXPECTED_RSV_2_3` 已建立连接非法帧路径由 `terminal-stream-hub` / `tasks-websocket-server`
    的 per-socket error listener 接住。回归测试: `terminal-stream-hub.test.ts` 钉 fake WS `error` listener,
    `terminal-ws.test.ts` / `tasks-watcher-ws.test.ts` 分别钉真实 HTTP upgrade 后 RSV2/RSV3 非法 frame
    不掀 runtime。

48. **chokidar tasks watcher 无 'error' listener —— USB 拔盘 / Defender EACCES / OneDrive 状态切换都直接掀进程**
    —— `src/server/tasks-file-watcher.ts:86-101`
    `chokidar.watch(...)` 之后只挂了 `add`/`change`/`unlink`/`ready`,**全文 0 个 `'error'` 字符串**。
    chokidar 5 (`handler.js:175-193`)对非 ENOENT/ENOTDIR 错误 `emit('error', ...)`,默认
    `ignorePermissionErrors:false` 所以 EPERM/EACCES 也直接广播。Windows 特定触发面:
    - USB workspace 拔盘 → `STATUS_DEVICE_REMOVED` → EPERM/EIO;
    - 映射网络盘 VPN drop / 睡眠唤醒 → `STATUS_BAD_NETWORK_PATH` → EIO/ENETUNREACH;
    - Defender / 企业 AV 临时占文件 → EACCES;
    - OneDrive Files-On-Demand 用户清缓存 → `ERROR_CLOUD_FILE_NOT_IN_SYNC`(0x80070179)。
    Node 默认 EventEmitter 在没有 'error' listener 时**抛出**,即 uncaughtException → 整个多 workspace
    runtime 死。R2 #20 只覆盖了 UNC `ready` 永挂、R3 #45 只覆盖 UNC `close()` 挂,**post-ready 本地盘
    上的 error 事件**仍未盖。
    修法:`watcher.on('error', (err) => { log; stop(workspaceId); setTimeout(retry, 5000) })`,把
    workspaceId context 留住,自愈重连。

#### 编码与 spawn 簇 —— Windows-only 静默语义破损

49. **node-pty spawn 未管 ConPTY 输入码页,中文/日文 Windows 上 bootstrap prompt 进 worker 即乱码**
    —— `src/server/agent-manager.ts:115-119` + `src/server/agent-startup-instructions.ts:20,30,37`
    `spawn(...)` 只传 `{cwd, env, name: 'xterm-256color'}`,不设 `useConpty`/`encoding`/`cols/rows`/`flowControl`。
    Hive 启动后 `pty.write` 包含中文的 bootstrap("`[Hive 系统消息:启动说明]`"、"`你是 <ws> 的 <agent>`"、
    "`你的角色:…`")给 worker。Windows ConPTY 输入路径上,UTF-8 字节流可能被 child 的 `GetConsoleCP()`
    (默认 OEM:zh-CN=936、ja-JP=932)重新解释 → CJK 多字节序列错位 → worker 收到 mojibake,
    角色绑定/工具白名单/persona 全部静默回归。POSIX PTY 是字节管道无码页层,同 prompt 干净穿透。
    全仓库 grep `chcp`、`65001`、`SetConsoleCP`、`useConpty` 均 0 命中。考虑到产品的中文用户为主、
    Hive 的整个 worker 角色机制依赖 prompt 注入,**严重程度按 HIGH 计**(虽然某些 Win11 22H2+
    的 ConPTY 对 UTF-8 输入容忍度更好,影响随宿主 build 浮动)。
    修法:(a)Windows + `.cmd` launch 路径下,在 spawn 命令前插入 `chcp 65001 >nul && `;
    (b)写入第一条 prompt 前先 `pty.write('chcp 65001\r\n')`;(c)同时 pin `useConpty:true` +
    `cols:80, rows:24` 默认,行为跨 Win10 build 确定化(顺带解 Critic #2)。

50. **workflow ephemeral agent 并行 fan-out:每条结束时同步 taskkill,事件循环冻结到 HTTP 超时**
    —— `src/server/workflow-runner.ts:247-355`
    `agent()` 的 finally 调 `store.deleteWorker(workspaceId, worker.id)`(line 348),链路
    `deleteWorker → stopAgentRun → stopLiveRun → agentManager.stopRun → run.process.stop() → killPty
    → taskkillProcessTree → execFileSync('taskkill', ['/pid', pid, '/t', '/f'])`(agent-manager-support.ts:13-15)。
    `DEFAULT_MAX_CONCURRENT_AGENTS = min(16, cores-2)` 的 `parallel(items.map(...))` fan-out 完成时,
    一批 finally 在临近的微任务批里集中触发,每个 taskkill 同步枚举进程树 + TerminateProcess 每节点,
    每次 100ms-3s(Defender 实时扫描下更长),16 × ≈ 数十秒 libuv 阻塞 → 期间 HTTP 不刷、WS ping/pong
    丢、浏览器见 "Failed to fetch"。POSIX `process.kill(-pgid, signal)` 非阻塞,同结构无该锯齿。
    R2 #15 / R3 #34 已点 taskkill 同步本身;**本条是 workflow DSL 的 spawn/dismiss-per-call 模式让
    单点同步代价乘以 fan-out 宽度** —— 独立的修法点。
    修法:(a)`deleteWorker` 拆成 stopRun-async + DB-only,finally 只动 DB,kill 走 fire-and-forget;
    (b)ephemeral worker 清理离开 hot path(标 GC + 异步 sweep);(c)同时按 R2 #15 把 taskkill 改异步。

### MEDIUM(7)

| # | 文件 | 问题 | 修法要点 |
|---|---|---|---|
| 51 | `src/server/agent-command-resolver.ts:45-57, 66-89` | `getWindowsExecutableNames` 末尾把**裸命令名**作为最后 fallback,而 `canExecute` 在 win32 用 `F_OK`(仅存在性)而非 `X_OK`。PATH 上若有他人放的 extensionless POSIX 脚本(`#!/usr/bin/env bash` shim,Git Bash/MSYS2 常见)→ 解析为该文件 → node-pty `CreateProcessW` 见非 PE 头返 `ERROR_BAD_EXE_FORMAT`(193,ENOEXEC)→ user 见 libuv "UNKNOWN"。`assertCommandIsExecutable`(line 162-168)同流污染 → preflight 绿灯、autostart 才炸,无诊断路径。cmd.exe/PowerShell 自身的搜索语义 NEVER fall through 到无扩展名,Hive 比 OS 更宽松。 | win32 分支移除 line 56 的裸 `command` fallback;额外要求 `extname(name).length > 0` 或 stat 后断 isFile() |
| 52 | `src/cli/hive.ts:201-206, 224` | Windows Hyper-V / Docker Desktop / WSL2 NAT / HTTP.SYS 在 iphlpapi `excludedportrange` 里动态保留端口;命中保留区的 `bind()` 返 WSAEACCES → libuv `EACCES`(非 EADDRINUSE)。`formatListenError` 只识 `EADDRINUSE`,raw `Error: bind EACCES 127.0.0.1:3000` 直透,而该端口在 `netstat -ano | findstr :3000` 是**空**的,user 无 google 路径。默认 3000 端口在 Win11 + Docker 之下经常被吃进保留区。 | `formatListenError` 加 win32 EACCES 分支,提示 `netsh int ipv4 show excludedportrange protocol=tcp` 并推荐 >= 49152 的端口;refactor 出 `formatBindError(code, port, platform)` |
| 53 | `web/src/workflows/WorkflowsDrawer.tsx:789-796, 884-897` + `src/server/routes-workflows.ts:197` | 工作流源码内联编辑器:HTML5 `<textarea>` 的 `.value` IDL 规定把所有 CR/CRLF 归一化成 LF。Windows 默认 `core.autocrlf=true` 下 checkout 的 `.hive/workflows/foo.ts` 是 CRLF,加载显示正常,但用户敲一个字 `onChange` 立刻拿到 LF-only 字符串 → PUT 直回写 → `git status` 整文件 EOL 翻 → 行号 blame 全乱。R1 #8 的 `detectEol` 修了 tasks.md 同型 trap,**workflow editor M5b 上线时未复用**。 | `handleSaveEditor` 里 `const eol = editor.initialSource.includes('\r\n') ? '\r\n' : '\n'`,写之前替换;或直接 import `web/src/tasks/task-markdown.ts` 的 `detectEol`;单测 round-trip CRLF |
| 54 | `src/server/open-target-commands.ts:84-103` | `cmdExeShimAttempt` 把每个编辑器(vscode/cursor/zed)的 path 不转义地塞进 `cmd.exe /d /s /c <bin> <path>`。cmd 命令行预处理器**永远**对参数尾做 `%VAR%` 替换(`/d`/`/s` 都不抑制),NTFS 又允许文件名含 `%`。`C:\dev\test%USERNAME%dir` 被替换为 `C:\dev\test<actualuser>dir` → 路径不存在 → 走 `app-not-installed` stderr 分类器误报。`escapeCmdToken`(agent-command-resolver.ts:106-110)同样漏 `%`。 | path 进 shim args 前把 `%` 加倍成 `%%`(cmd 唯一的字面百分号惯用法);更好的是放弃 cmd 包装,JS 内 `resolveCommandPath` 拿到 `.cmd` 绝对路径后直 spawn |
| 55 | `src/server/open-target-commands.ts:175-194` | `APP_NOT_INSTALLED_PATTERNS` 只识英文 `is not recognized as an internal or external command` 与简体中文 `不是内部或外部命令`。法/德/日/韩/俄/西/葡/繁中 cmd.exe 都本地化了同句话,user 命中 → `classifyFailure` 回 `unknown` → UI 跳泛错 `Couldn't open in {app}` 而非可操作的 `Couldn't find {app}…`。非英文 Windows SKU 在 CN/JP/KR/DE/FR/RU 都是常态。 | 改判 `result.status === 9009`(Windows 通用"命令找不到"退出码,locale 无关);或 spawn 前先 `resolveCommandPath(bin, cwd, env, 'win32')` 命中 ENOENT 时同步返 `app-not-installed`,根本不走 cmd |
| 56 | `src/server/routes-workflow-schedules.ts:41-55` | POST `/workflow-schedules` 把 `script_path` 原样落库,**没有** PUT `/workflows/source` 的 `resolveSafeScriptPath` 校验。Windows 下 UNC `\\\\server\\share\\workflows\\foo.ts` 是合法路径,scheduler tick(workflow-scheduler.ts:91,30s 默认间隔)同步 `await loadWorkflowScriptFile → readFile`,share 不可达时 SMB 阻塞默认 ~45s 拖死 tick worker;多条 UNC schedule 串行更糟。需 UI token 认证,所以属可认证 DoS,但 schedule 失效会很久没人发现。 | 入库前 `realpathSync.native` + `isPathWithinRoot(<ws>/.hive/workflows/)`;显式拒 UNC;scheduler tick 内 `Promise.race` + 5s 超时 |
| 57 | `src/server/runtime-database.ts:8-17` | `mkdirSync(dataDir, { recursive: true })` 无 try/catch。`dataDir = %APPDATA%\hive` 在企业 GPO Folder Redirection 到 SMB 且写 ACL 受限时 `CreateDirectoryW` 返 EACCES → 同步抛 → 经 `runHiveCommand(...).catch(...)`(hive.ts:321)只 `console.error(error.message)`,**不提示已存在的 `HIVE_DATA_DIR` env 覆盖出口**。R3 #30 是 workspace-path 同型;本条在 boot 更早,完全没 recovery 提示。 | catch EACCES/EPERM,提示 user 设 `HIVE_DATA_DIR` 到本地盘;同步推一条 actionable error |

### LOW(7)

| # | 文件 | 问题 |
|---|---|---|
| 58 | `web/src/useGlobalShortcuts.ts:26-27, 40-56` | `hasMod` 在非 Mac 只查 `event.ctrlKey`,不检查 `event.altKey`。Windows AltGr(欧洲键盘的 Right Alt)生成合成 Ctrl+Alt keydown,所以 AltGr+1..9 / AltGr+Shift+N 在 PWA standalone 模式下错误触发 workspace 切换 / Add Workspace 快捷键。`TerminalBottomPanel.tsx:60-61` 同型 keydown 已防 `!event.altKey`,这里漏。修法:handler 顶端加 `if (event.altKey) return`,或 shortcut 定义里加 `alt?: boolean` 默认 false |
| 59 | `web/src/workflows/WorkflowsDrawer.tsx:95-103, 105-106, 381, 408, 549-555` | `argsLabel`/`formatResultText` 对非字符串 args/result 走 `JSON.stringify` 然后渲染。RFC 8259 § 7 把每个 `\` 转义为 `\\`,React textContent 不解码 → Windows 路径 `C:\Users\me\repo` 显示成 `C:\\Users\\me\\repo`。Clipboard `Copy` 写 raw JSON 正确(下游能 parse),纯视觉问题。修法:加 `formatJsonForDisplay`,渲染前 unescape `\\\\` 与 `\"`,Copy 仍写 raw JSON |
| 60 | `src/server/session-capture-claude.ts:22` + `src/server/session-capture-gemini.ts:13-23` + `src/server/session-capture-opencode.ts:9-46` | 三处的 `expandHome` 只处理 `~` 与 `~/`,不处理 Windows `~\`;default-pattern 等值检查也用 `===` 而非 `arePathsEqual(..., 'win32')`。Codex 的 `session-capture-codex.ts:23` 已用 `arePathsEqual` 防御。user 若把 preset `sessionIdCapture.pattern` 自定义为 `~\.claude\projects\…`(Explorer "Copy as path" / PowerShell `Resolve-Path` 输出风格),`existsSync` 在字面 `~` 段下失败 → `withPresetResumeArgs` 清掉 session id → Layer A resume 静默降级到 Layer B。修法:抽统一 `expandHome(path, 'win32')` 同识 `~\`;default-root 检查改 `arePathsEqual` |
| 61 | `src/server/routes-workflows.ts:29-38, 183-200` | `resolveSafeScriptPath` 不做 case-folding。Windows NTFS / macOS APFS 默认 case-insensitive(Hive 维护者自家 macOS 即命中),PUT `Foo.ts` 再 PUT `foo.ts` 落到同一 inode,第二次静默覆盖第一次;UI list `scanWorkflowScripts` 返先写者的存储名 vs user 看到的输入名,体验不一致。R2 路径簇没盖 workflow drawer 这一面。修法:write 前 readdir + lowercase 对比,409 ConflictError 返 canonical 名 |
| 62 | `src/server/workflow-script-loader.ts:169` + `src/server/routes-workflows.ts:34, 217` | `entries.filter((name) => name.endsWith('.ts'))` 用 byte-strict `endsWith`。NTFS case-preserving:`New-Item review.TS` / git checkout 大写扩展名的文件 readdir 返保留原 case → filter 漏 → UI 看不见,但 CreateFileW 仍 case-insensitive 命中,造成"直接 path 跑得动 / 列表里不在"split-brain。同时影响 PUT/GET source 路由的过滤。修法:`name.toLowerCase().endsWith('.ts')`,三处一起改 |
| 63 | `src/server/agent-command-resolver.ts:6-13, 45-57, 66-89` | 与 #51 同条目的不同视角:bare-command fallback + F_OK 在跨 dir 情况下让 PATH 上靠前的 extensionless POSIX shim 屏蔽掉靠后的真 `.cmd`。已在 #51 列出,此处仅作 cross-ref(原 finding 标 LOW,#51 标 MEDIUM,合并按 MEDIUM 处理) |
| 64 | `src/server/runtime-database.ts:8-17` cross-ref | 与 #57 同条目的 boot-time 视角 cross-ref:严格 MEDIUM 已计;LOW slot 不重复 |

### Round 4 驳回(18,3-lens 校验 NOT_REAL)

逐条一句话理由:

| 标题(摘) | 驳回理由 |
|---|---|
| `buildSpawnPathEnvEntry` 触 32KB env block 限 | 该限制只约束 `lpCommandLine` 与单个变量值;`CREATE_UNICODE_ENVIRONMENT` 下整块 env 实际不受 32KB ceil,Hive 贡献量 <500 字节远低阈值 |
| node-pty 1.x "删了 winpty fallback" 致老 Win10 静默挂 | 1.1.0 仍带 winpty backend(`lib/windowsPtyAgent.js:37-50` 自带 build 号探测自动选 conpty / winpty),前提事实错 |
| `pty.write` Windows 同步 WriteFile 阻塞 event loop | node-pty 1.1.0 实际经 `net.Socket` 写 conin pipe,异步 buffered;无同步 WriteFile 调用,机制虚构 |
| ConPTY 默认 80x24 + resize 重绘破 paste-ack 检测 | `run.output` append-only,`baselineLength` 是绝对偏移,resize 重绘字节落在 baseline 之后仍被 regex 命中 |
| postinstall `chmodSync` 无 AV 重试 | 实际 chmod 目标只是 bin/team.cmd 与 spawn-helper(POSIX-only,Windows 上 existsSync 即 skip),从未碰 `.node` 文件,AV 命中模型不适用 |
| 静态资源 AV-lock 致 404 | 描述的 `FILE_SHARE_NONE` AvScan 机制不准确(Defender 是 minifilter 不持竞争 user-mode handle);bare-catch 是真,但非 Windows-only |
| `/ws/tasks` 初快照 AV-lock 致面板清空 | `ensureTasksFile` 写后不再 read 同文件(返内存中 `content` 变量),所谓"写后立即读"竞态不存在 |
| Marketplace `readAgent` AV-lock 致 500 | Defender 实时扫描典型不持续锁静态 .md;重启自愈,且数百只读文件并发首读的扫描窗口极窄,无证据支撑 ~5% 失败率 |
| Workspace 路径 8.3 短名让 session resume 失败 | 需 user 主动粘 `PROGRA~1` 形态;OS picker 不返 8.3,且 Codex 源码确认未 canonicalize cwd,假设链断 |
| PUT `/workflows/source` writeFile + AMSI Defender 锁 .ts | AMSI 只覆盖 PowerShell/VBScript/JScript/VBA,不含 TypeScript;非原子写跨平台同样存在 |
| POST `/install-template` `wx` EEXIST + NTFS 尾空/点 | repro 用的是 `foo .ts`(中间空格)而非尾随空格/点,Win32 仅规范化终止字符;严格 `.endsWith('.ts')` 已挡掉真正的尾随场景 |
| GET `/workflows/source` ENAMETOOLONG/EACCES 500 | libuv 在 Windows 自动用 `\\?\` 长路径前缀,260 限不在 Node 层暴露;line cite 也错(指向 GET templates 而非 source) |
| workflow finally taskkill cascade 阻塞(489-502) | 每 agent 自身 try/finally(line 346-355)已先在 per-call 路径清掉,外层 finally 是 belt-and-suspenders,正常路径 spawnedWorkers 已空 |
| `ensureWorkerRun` restart race + Claude `--resume` 读半截 JSONL | 推测 Claude CLI 内部行为且无 evidence;`getActiveRunByAgent` 看的是 run.status,onExit 同步翻 status,无所述时间窗 |
| Scheduler `tz:'UTC'` + Windows `RealTimeIsUniversal` 注册表 | `RealTimeIsUniversal` 是 dual-boot 修复方案不是触发器;本质是跨平台的"未让 user 设 tz"UX,不是 Windows-specific |
| PUT `/workflows/source` 非原子 + VSCode oplock 致 EBUSY | VSCode/Cursor/Notepad++ 不持文件 handle、不持 oplock,机制虚构;Node libuv `fs__open` 已传 `FILE_SHARE_READ|WRITE|DELETE` |
| executeWorkflow shutdown race 致 orphan claude.exe | shutdown 序列 cancelAll → shellRuntime.close → await agentRuntime.close,close 体在第一次 await 之前先同步对每个 run 调 stop()/taskkill;DB 直到最后才关 |
| `mkdirSync(dataDir)` `OneDrive KFM` / `mandatory profile` / `AppLocker` 多路径触发 | OneDrive KFM 明确不覆盖 AppData;AppLocker 管执行不管 file-create ACL;mandatory profile 不装 filter driver;只剩 corp Folder Redirection 这一窄路径,已并入 #57 |

---

## 建议的修复批次

1. **崩溃 hardening pass(HIGH #1-4)** —— 收益最高、改动集中、最可能终结线上 "Failed to fetch"。建议先做,按 TDD。
2. **路径身份 + 退出码分类簇(HIGH #6/#7 + MEDIUM #9/#13/#14)** —— 统一 exit-code 分类器 + native realpath + create 去重,一并解决。
3. **watcher 韧性(HIGH #5 + MEDIUM #10 + LOW #20)** —— 落地前先实测 chokidar 行为;倾向 usePolling 一招同解。
4. **sandbox canonicalize(MEDIUM #12 + LOW #17)** —— 复用 `validateWorkspacePath` 的 realpath 模式。
5. **其余 MEDIUM/LOW + Critic 盲区** —— 按需。最高杠杆是搭一个 Windows CI runner。

---

## 用户上报 Issue(GitHub `tt-a1i/hive` public)

> 记录日期:2026-05-30
> 来源:public repo 外部用户实测上报;具体报告人与环境以各 issue 为准
> 与上面"内部审计 Round 1-4"不同 —— 这是外部真实用户在 Windows 上跑出来的,逐条标注根因归属
> (Hive 自己 / 上游 CLI)与状态。**注意**:已修条目都在 `feat/workflow-runtime` 分支、**尚未合 main、未发版**,
> 报告人跑的发布版 1.4.4 仍会中招。落地/回复前重新核对 `git log`。

| Issue | 标题(摘) | 根因 | 状态 |
|---|---|---|---|
| #17 | 无法打开 Orchestrator | Hive:Windows 下 quoted `.cmd` 启动命令经 node-pty 序列化成 `\"...\"`,导致 `cmd.exe` 把反斜杠+引号当成命令名;`Cannot resize a pty that has already exited` 是 PTY 已退出后的后续噪音 | **分支已修 / 1.4.2-1.4.4 发布版仍会中招**:`00363c5`(Windows `.cmd/.bat` 与 `cmd.exe /c "<raw command>"` verbatim handoff;`startup-command-parser` / `agent-command-resolver` 回归测试);已回复 |
| #18 | Orchestrator 运行一会后服务停止 | Hive:已建立 terminal/tasks WebSocket 缺 `error` listener;非法 frame(`WS_ERR_UNEXPECTED_RSV_2_3`)触发 unhandled `error` → runtime 退出 | **分支已修 / 1.4.4 发布版仍会中招**:`bd117d7`(raw socket / wss / established WS error handler)+`3ad10ba`(#18 专属非法 frame 回归测试);**回复草稿待发** |
| #19 | Windows 下 Codex preset 参数可能被错误传给 `node.exe` | Hive:存量 launch config 可落成 `node.exe + @openai/codex/bin/codex.js`;preset augmentation 把 Codex yolo 参数插到 JS 入口前,变成 Node 参数并立即退出 | **分支已修 / 1.4.4 发布版仍会中招**:`a341a0d`(Codex preset 启动前规范化 stale `node.exe` npm entrypoint;Layer A + session support 回归测试);**待回复** |
| #21 | Codex 转发内容只粘贴未自动提交(Windows) | Hive:`post-start-input-writer` 的 Codex paste-ACK 门控 | **分支已修 / 1.4.4 发布版仍会中招**:`e0c40a1`(ack-gated 提交 + 首个 Enter 被吞则补发 + Codex 专属 10s 超时;真 PTY 回归测试);已回复 |
| #22 | 补充派单引用原 dispatch 残留 pending,worker 卡 working | **设计如此**(每次 `team send` 是独立 dispatch、各自要 report;一次 report 只关一个) | **非 bug**;`report-pending-count.test.ts` 钉死该记账;`a292a06` 已加 orchestrator guidance 明确每次 `team send` 都是独立 dispatch;已回复 |
| #24 | stale terminal WebSocket 写 inactive PTY 掀翻 runtime | Hive:io WS `message` handler 裸 `writeRunInput` 未兜 throw → uncaughtException | **分支已修 / 1.4.4 发布版仍会中招**:`bd117d7`(io handler try/catch → 回灌 `type:"error"` 给该 socket;`terminal-stream-hub.test.ts` 回归);已回复 |
| #20 | 未信任工作区时 Codex agent 启动无提示 | **上游 Codex 回归 `#14345`** + Hive UX 缺口 | **待处理**(下方详记,未实现) |

### #20 —— 未信任工作区时 Codex agent 启动卡死且无提示(待处理)

**现象**:在一个从未被 Codex 信任过的新目录里,从 Hive 内启动 Codex(orchestrator 或 worker),agent 进不了可用态,UI 一句解释都没有;用户得先手动在该目录跑一次 `codex` 把信任流程过掉,再回 Hive 才正常。

**根因(上游,非 Hive 配错参数)**:Hive 启动 Codex 用的是 `codex --dangerously-bypass-approvals-and-sandbox`(`command-preset-defaults.ts:13`),本应连目录信任提示一起跳过。但 Codex 自 **v0.114.0** 起回归(`openai/codex#14345`,标 bug+regression,从 v0.112.0 退化),由 PR #11874「fix(tui) remove config check for trusted setting」引入:**即便带该 flag,Codex 仍弹「Do you trust the contents of this directory?」**。同一个 PR 还**删了 `config.toml` 的 trust 检查**,所以"启动前预写 `[projects."<path>"] trust_level = "trusted"`"这条最干净的绕法,在受影响版本上也废了。报告人 0.135.0 正好命中,截至记录日无官方修复。

**Hive 侧缺口(与上游无关、Hive 该兜的部分)**:
- 全代码库**无任何 trust/onboarding 处理**(grep `trust`/`onboard` 仅命中 fs-sandbox、i18n 文案、Hive 自己的 wizard first-run flag,均无关)。
- 信任提示其实会在 PTY 里渲染,xterm 终端里用户理论上能答。但启动注入逻辑(`post-start-input-writer.ts`)会**冲掉它**:ready 门 `hasInteractivePromptReady`(`:48-54`,line 51 认 `(?:^|[\r\n])\s*[❯›]`)—— Codex 信任对话框是键盘选择式 TUI、行光标正是 `›`/`❯`,**很可能直接在信任框上误判 ready**;即便不误判,codex 走 `canTimeoutBeforePromptReady=true`(`:78`),3s(`READY_TIMEOUT_MS`,`:6`)超时后**照样 bracketed-paste 启动指令**(`:235` 的 ready-or-timeout 分支)→ 一大段 paste 灌进一个选择式对话框 → 既完不成信任又搅乱屏幕。净效果就是报告人说的"agent 像启动失败、无提示"。

**建议修法(分档)**:
- **档 1(推荐:便宜 / 低风险 / 不脆)**:用 Hive 已有的可靠信号 —— "**到点超时却从未匹配到 `❯`/`›` ready**"(即走了 `:235` 的 timeout 分支而非 prompt-ready 分支)—— 这恰恰是 agent 卡在非正常屏幕(信任/onboarding)的特征。此时别再静默 paste 了事,而在 UI 给明确状态:"agent 还没进入输入态,可能在等一个确认 —— 去终端看一眼"。**不 scrape 任何文案、不改 paste 语义、纯附加式**,版本漂移也不失效,不会回归别的 CLI。
- **档 2(可选:略脆)**:Codex 专属 —— 认出信任提示文案后,在真正的 `❯` 出现前**先别注入、别冲掉对话框**。更对症,但要 match Codex 具体文案,而这块 0.114 才刚改过,会随版本漂。
- **不做**:往用户 `~/.codex/config.toml` 写预信任(#14345 已废 + 动用户配置)、完整 preflight、专门"信任按钮" —— 对一个**可能被上游 revert** 的回归过度投入。

**一致性说明**:这与我们反对 #22 的正则方案不矛盾 —— #22 是拿正则解析 orchestrator **自由文本**、还**改核心记账**(跳过 createDispatch),误判直接改变真实行为,爆炸半径大;这里档 1 用的是 Hive 自己的 ready/timeout 状态(不 scrape),最坏也只是"多给一句提示"。反对的是"脆 + 改行为",不是反对所有兜底。

**上游**:跟踪 / +1 [`openai/codex#14345`](https://github.com/openai/codex/issues/14345);根因得等 Codex 修,但"别帮倒忙 + 给提示"(档 1)Hive 现在就能自己兜。
