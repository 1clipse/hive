# Mobile Remote Access — 完整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只要本机 Hive 在运行，用户在任何地点用手机浏览器打开固定网址、GitHub/Google 登录后，访问**完整的 Hive Web UI**——已配对手机是与本地浏览器**等权**的受信任客户端，通过 E2E tunnel 使用同一套 HTTP/WS 能力。生产可用的完整版本；M1–M7 是内部 build gate（各自可测试、可回滚、可审计），不对外发半成品，M7 后作为完整功能一次发布。

**这是对 "no cloud / 仅 127.0.0.1" non-goal 的正式反转**（与 2026-06 spec §10.2 任务依赖的放宽同性质）。边界必须守住并写进文档：云端组件只做**身份 + 路由**，数据与执行永在本机，网关不可用时本地一切照常。

---

## Authority Model（权限模型，实现与评审的最高准绳）

> Paired remote device has the same authority as the local Hive web UI. Hive does not
> maintain mobile-specific feature permissions. Security is enforced at the
> device/session level, not the action-subset level.

- 配对成功的手机 = 本地浏览器等权。理由：任何包含"能向 YOLO agent 发送文本"的权限子集本质已是全权（RCE 级），按钮级裁剪是安全剧场——增加摩擦，不增加安全。
- 安全层全部在**设备/会话级**：OAuth 登录、首次配对、桌面确认、设备吊销、远程会话审计、远程访问总开关（默认关）。配对之后不做任何手机专属权限系统；移动壳可以调整入口/隐藏危险快捷按钮，但不能让隧道 API 变成权限子集。
- **信任根例外（不是权限裁剪，是配对仪式设计，禁止后续当"不一致"修掉）：**
  - 新设备配对审批**只能在桌面完成**——已配对手机不能凭自己铸造新设备。
  - Remote 总开关：远程**可关**（自断连，需确认弹窗），**不可远程打开**（关闭 = 无隧道，物理上也做不到）。
- tunnel 代理边界：**仅** Hive runtime 自己的 `/api/*` 与 `/ws/*`（回环桥接挂路径白名单，其余一律拒）。不代理任意 localhost，不做通用内网代理。gateway 只转发密文，不理解 API。
- daemon 侧给每个远程请求/流打 `remote_device_id`，用于审计与吊销断连；不用于权限分支。

---

## 架构总览

```
[手机浏览器] --wss(密文)--> [☁️ Gateway (CF Workers+DO+D1)] <--outbound wss(密文)-- [本机 Hive daemon]
      │                          │
  同一套 Hive Web UI             OAuth (GitHub/Google)
  (responsive shell;             账号 ↔ daemon ↔ device 路由
   bundle 按 daemon 版本分发)     (opaque relay,不解密)
```

锁定的设计决策（执行中不再重开）：

1. **唯一远程通路是 gateway 中转**。daemon 主动出站连 wss（不开端口、不动路由器、公司网可穿）。不做 LAN 直连模式——一条传输路径，少一半弱网/安全长尾。本机 localhost 使用完全不变。
2. **E2E 加密不可裁剪**。手机 ↔ daemon 间所有数据帧端到端加密（X25519 配对 + HKDF 会话密钥 + XChaCha20-Poly1305），gateway 只见密文和路由头。
   - 诚实的边界（写进 threat model 与文档）：手机端 crypto 代码由 gateway 分发（web 端 E2E 的经典局限，同 Proton/WhatsApp Web）。缓解：SRI、版本化 bundle、PWA service-worker 缓存形成 TOFU。不宣传成"gateway 被攻破也绝对安全"。
3. **首次配对必须人在电脑前**：桌面出一次性配对码（图形码入口已取消）→ 手机输入配对码 → 经 gateway 完成 E2E 握手 → **桌面弹窗确认**才算配对成功。
4. **账号模型保持单主人**：账号 = OAuth 身份（首次登录即"注册"，不存密码）；一个账号可绑多台 daemon、多台手机设备。**不做**共享/协作/多用户授权。
5. **UI 策略：responsive shell，同一 app 同一批组件**。按断点切换布局壳；手机布局可以不同（底部导航、全屏面板替代三栏、终端 focus mode），但不新增 mobile-specific API，也不在隧道层做按钮级权限裁剪。bundle 由 gateway 按 daemon 版本分发（CI 每次 release 上传 `assets/<version>/`），握手时 daemon 报版本、手机加载匹配 bundle——消灭版本偏斜。
6. **gateway 代码随主仓公开**（`gateway/`，独立 package.json，独立部署、不进 npm tarball）。但 daemon 侧 gateway URL 可配置（self-host 自己的 gateway 也能用），保持开放姿态。
7. **整个功能挂 Settings 开关**（"Remote access"，默认关）。关闭时零监听、零出站连接、零行为变化。

**Tech Stack：**
- Gateway：Cloudflare Workers + Durable Objects（WS 中转/每账号路由）+ D1（users/daemons/devices/sessions 小表）+ wrangler；OAuth 手写 code flow（GitHub）+ OIDC（Google）
- E2E：`@noble/curves`（x25519）+ `@noble/ciphers`（xchacha20poly1305）+ HKDF——纯 JS、browser+node 通用、无原生依赖
- Mux：自研最小多路复用帧协议（JSON 头 + 二进制载荷），流控复用终端 ws-server 已有的双水位线 + ack 范式
- daemon 侧：`ws` 出站客户端；隧道请求经 127.0.0.1 回环代理（路径白名单）进既有 router（带 per-boot 内部密钥头 + `x-hive-remote-device`）
- 手机 UI：现有 app 的 responsive 化 + `web/src/mobile/` 布局壳（壳不同、组件同源）；传输层抽象（direct fetch/WS vs tunnel）
- 测试：gateway 用 `@cloudflare/vitest-pool-workers`；daemon 隧道集成测试对接进程内 fake gateway（真 ws）；终端经隧道的测试用真 PTY（repo 铁律）

**Repo:** `tt-a1i/hive`，分支 `feat/mobile-remote`

---

## Remote Transport Contract（隧道必须支持的语义，M1/M3 验收依据）

| 语义 | 要求 |
|---|---|
| HTTP request/response | 完整 method/path/headers/body 往返；流式响应；in-flight 时隧道断 → 明确失败（不悬挂） |
| Terminal WS（io + control） | 双向、二进制安全；resize/attach 控制帧；多观众语义与本地一致（TerminalStateMirror 快照回放） |
| Tasks/事件 WS | 与本地 WS 同语义（tasks.md watch、状态推送） |
| 大量终端输出背压 | per-stream 流控窗口 + ack；慢手机不得撑爆 daemon 内存；丢线后重连取**快照**不取增量 |
| Reconnect restore | 手机锁屏/切网回来：会话续用、流重建、UI 状态恢复；daemon 断网：指数退避重连 + UI banner |
| Binary input / paste | 终端 stdin 二进制安全；手机直接聚焦 xterm 输入/粘贴，bracketed paste 语义由终端层保留；当前不再提供独立 composer / 粘贴确认行 |
| UI session refresh | 页面刷新后凭已配对密钥静默重建会话，无需重新配对 |
| **Hive UI session / loopback auth** | 桌面 same-origin 仍使用 `/api/ui/session` cookie；隧道请求不持 UI cookie，`/api/ui/session` 对 tunnel hard-deny。daemon 回环桥接用 per-boot internal secret 认证，手机刷新后凭已配对设备 session 静默重建 tunnel |
| 协议版本 | 帧协议带版本字段，不匹配走明确错误 + 升级提示 |

---

## Parity Matrix（桌面 ↔ 手机能力对照，M5 验收的硬清单）

| 桌面能力 | 手机 | 交互差异 | 测试 |
|---|---|---|---|
| workspace 列表/切换/新建/删除 | ✅ | 侧栏 → 抽屉/独立页 | mobile shell 测试 |
| 添加 workspace：OS 目录选择器 | ⚠️ 替代 | 原生选择器不可远程弹出。**移动 add-workspace 流程禁止调用 `/api/fs/pick-folder`**（会在电脑上弹出 OS picker）→ 必须走手动输入路径 + `/api/fs/browse` + `/api/fs/probe`（routes-fs.ts 已有，走隧道即用）。这是物理交互替代，不是权限裁剪 | **负向测试：移动 add-workspace 不得发 `/api/fs/pick-folder`**；正向：browse/probe over tunnel |
| agent 创建/启动/停止/重启/删除/重命名 | ✅ | hover 操作 → 可见按钮/长按菜单 | 组件 + 审计断言 |
| orchestrator 输入 | ✅ | 直接聚焦 xterm 输入；运行态 Stop 快捷按钮在手机隐藏，避免覆盖触摸滚动区；停止/重启仍由桌面/成员操作面承载 | 真 PTY 经隧道 |
| **worker 终端查看 + 输入** | ✅ **可写** | 直接聚焦 xterm 输入；终端全屏 focus mode 隐藏底部 tab；IME 真机验证（iOS Safari + Android Chrome）、WebGL → canvas 降级 | 真 PTY + 真机清单 |
| tasks 图查看 | ✅ | 全屏页替代 drawer | 组件测试 |
| workflows（列表/详情/Stop/Retry/日志） | ⚠️ 当前桌面入口 | drawer 组件保留并有移动全屏组件测试；当前移动底部导航不暴露 Flows tab，避免扩散首版手机主流程 | 组件测试 |
| settings（含 webhook、实验开关） | ✅ | 同组件响应式 | 既有测试 + 移动断点 |
| device management（设备列表/吊销） | ✅ | 手机可吊销任意设备含自己（需确认） | 吊销闭环测试 |
| **新设备配对审批** | ❌ 设计如此 | 信任根留桌面（见 Authority Model） | 负向测试：远程审批必拒 |
| Remote 总开关 | ⚠️ 仅可关 | 远程关闭 = 自断，需确认；开启只能在桌面 | 负向测试 |
| open in editor / finder | ✅ 语义不同 | 动作在**电脑上**执行，手机只显示结果 toast | 集成测试 |
| hive update / runtime 重启提示 | ✅ | 重启 → 隧道断 → 重连横幅引导 | 重连测试 |
| errors / toasts / confirm dialogs | ✅ | 同组件响应式 | 既有测试 |
| 键盘快捷键 | ❌ N/A | 触屏无物理键盘（外接键盘时仍生效，不专门做） | — |
| 拖拽分栏/面板 resize | ⚠️ 替代 | 移动布局固定/折叠，不做触屏拖拽分栏 | 布局测试 |
| Clipboard | ✅ 语义区分 | 手机剪贴板（navigator.clipboard）与远程终端 stdin 明确分离；终端内复制走选区 → 手机剪贴板 | 终端交互测试 |
| 桌面通知/声音 | ⚠️ 部分 | PWA 通知尽力而为；webhook → ntfy/Bark 是既有的可靠通道 | — |
| Demo mode | ✅ | 纯客户端，天然可用 | 冒烟 |

> ❌ 仅允许出现在"物理不可能"、"信任根设计"或明确记录的移动交互安全取舍；隧道 API 不允许被做成手机权限子集。

---

## 前置条件（owner 手工任务，阻塞 M2 验收）

- [ ] 选定并购买域名（gateway + 手机入口，如 `app.<domain>`）
- [ ] Cloudflare 账号 + wrangler 登录 + 域名接入 CF
- [ ] 注册 GitHub OAuth App（callback 指向 gateway 域名）
- [ ] 注册 Google OAuth Client + consent screen（**注意：Google 生产审核有周级 lead time，尽早提交**；审核期间 testing 模式可供开发）
- [ ] secrets 注入 CF（OAuth client id/secret、JWT 签名密钥）

---

## File Structure

**Create（shared 协议层，node + browser 共用）：**
- `src/shared/remote-protocol.ts` — mux 帧格式、流状态机、协议版本协商
- `src/shared/remote-crypto.ts` — 配对握手（X25519+HKDF）、帧封装/解封（XChaCha20-Poly1305）、SAS 短码
- `tests/unit/remote-protocol.test.ts`、`tests/unit/remote-crypto.test.ts`

**Create（gateway，独立部署）：**
- `gateway/package.json`、`gateway/wrangler.toml`、`gateway/src/index.ts`（路由入口）
- `gateway/src/oauth-github.ts`、`gateway/src/oauth-google.ts`、`gateway/src/sessions.ts`（JWT 会话）
- `gateway/src/relay-do.ts`（Durable Object：每账号连接注册表 + 帧转发 + 吊销推送）
- `gateway/src/db.ts`（D1：users/daemons/devices/sessions/revocations）
- `gateway/src/bundles.ts`（按版本分发 UI bundle，R2 或 Workers Assets）
- `gateway/src/login-page.ts`（登录/机器列表/配对引导静态页）
- `gateway/test/*`（vitest-pool-workers）
- `.github/workflows/gateway-deploy.yml`（手动触发 + tag 时上传 web bundle）

**Create（daemon 侧）：**
- `src/server/remote-tunnel.ts` — 出站 wss 客户端：注册、重连退避、心跳、mux 流 ↔ 回环 HTTP/WS 桥接（**路径白名单：仅 `/api/*` `/ws/*`**）
- `src/server/remote-device-store.ts` — devices 表 CRUD + 吊销
- `src/server/remote-pairing.ts` — 配对 token 签发、E2E 握手 daemon 侧、桌面确认流转
- `src/server/remote-audit-store.ts` — 远程操作审计表
- `src/server/routes-remote.ts` — 配对/设备管理/开关的本地 API
- `src/cli/hive-remote.ts` — `hive remote login|logout|status|devices|revoke`
- `src/server/sqlite-schema-v23.ts` — devices + remote_audit + app_state 键
- `tests/server/remote-tunnel.test.ts`（进程内 fake gateway，真 ws、真 HTTP 桥接）
- `tests/server/remote-pairing.test.ts`、`tests/unit/remote-device-store.test.ts`、`tests/cli/hive-remote-cli.test.ts`

**Create（手机 UI = responsive shell）：**
- `web/src/transport/` — `ApiTransport` 接口 + `DirectTransport`（现状）+ `TunnelTransport`（E2E over gateway WS）
- `web/src/mobile/MobileShell.tsx` — 布局壳：底部导航 + 全屏面板路由（**承载现有组件，不复制功能**）
- `web/src/mobile/` 布局适配件：触屏操作面（hover→按钮/长按）、终端 focus mode、移动 workspace sheet
- `web/src/mobile/views/ConnectView.tsx`（登录/机器列表/配对引导，gateway 域专属）
- `web/src/mobile/entry-mobile.tsx` + vite 多入口/断点接线
- `tests/web/mobile-shell.test.tsx`、`tests/web/terminal-key-bar.test.tsx`、`tests/web/transport-tunnel.test.ts`、parity matrix 逐行对应测试

**Modify：**
- `src/server/app.ts` / `runtime-store.ts` — 挂载 remote 子系统（开关驱动生命周期）
- `src/server/sqlite-schema.ts` — v23
- `src/cli/hive.ts` — `remote` 子命令分发
- `web/src/settings/SettingsMenu.tsx` — Remote access 区块（开关、二维码、设备列表、吊销）
- `web/src/api.ts` + 终端 WS 客户端 — 走 transport 抽象（桌面默认 DirectTransport，行为零变化）
- 既有工作台组件 — 响应式断点适配（parity matrix 驱动，逐组件）
- `web/src/i18n.tsx` — 全部新 key（en+zh 同步，zh 必须全覆盖）
- `package.json` — noble 依赖、（gateway 不进 `files`）
- `README.md` / `README.en.md`、`CLAUDE.md` 决策表、`CLAUDE.md`

**不变（明确声明）：**
- `local-request-guard.ts` 一行不改——隧道流量经回环代理进入，本地守卫语义原样
- team 协议、agent 状态机、PTY/终端栈全部不动
- 不新增任何 mobile-specific API：手机用的就是现有 `/api/*` `/ws/*`

---

## 审计规格（审计不是权限——记录，不拦截）

**统一采集点（M3 就设计好，禁止 M4 再逐 route 手补）：**
- HTTP 远程请求：在 **tunnel/transport 层**统一拦截记录 `endpoint` + 结果 + 拒绝原因——所有远程 HTTP 都过这一层，一处采集覆盖全部 route，不污染各 route handler。
- 终端/WS input：在 **tunnel stream 层**记录字节数 + 截断预览（同一处也是路径白名单的执行点）。
- 落地：`remote-tunnel.ts` 桥接处发审计事件 → `remote-audit-store.ts` 异步写入（不阻塞转发）。

`remote_audit` 表，每条含：`remote_device_id`、时间戳、workspace、endpoint/action 类别、结果（成功/失败 + 拒绝原因）。重点动作：

- 远程会话建立/断开（含来源会话 id）
- agent start / stop / restart / delete / rename
- 终端与 orchestrator stdin 写入：**摘要**（字节数 + 截断预览），不存全文
- workspace 增删、settings 变更、设备吊销、Remote 开关变更
- 被拒请求（路径白名单外、已吊销设备、过期会话）及原因

桌面 Settings 可查看审计流水；新远程会话建立时走既有 notifications 通道弹桌面通知。

---

## Milestones（内部 build gate，非 MVP 分期；仅 M7 后对外发布）

### M1 — E2E crypto + mux 协议核心（纯逻辑，先行）— ✅ 完成（commit f99cf4d / deps 8655723）

- [x] **新增依赖**：`@noble/curves` + `@noble/ciphers` + `@noble/hashes`（均 v2.2.0，纯 JS）写入 `package.json`；`pnpm install` 通过、tsc build config 干净
- [x] `remote-crypto.ts`（537 行）：X25519 配对握手（一次性配对密钥 → 长期设备密钥对 → SAS 6 位短码）；HKDF 分向会话密钥；帧 seal/open；base64url 序列化（无 Buffer）。**Crypto 不变量（钉死，已全部落地并变异验证）：**
  - [x] frame header 作为 AEAD 的 **AAD 被认证**（变异：去 AAD → 恰好 2 个 invariant-1 测试挂）
  - [x] HKDF **分方向派生 key**（INFO_KEY_D2P / INFO_KEY_P2D 不同 label）
  - [x] nonce 绑定 `(direction, streamId, seq)`：seq 严格 +1 防重放/乱序 + streamId 防跨 stream 复用
  - [x] 握手 transcript bind `daemonId` + `deviceId` + `protocolVersion` + 每会话 `sessionSalt`（变异：去 protocolVersion → 恰好 invariant-4 downgrade 测试挂）
- [x] `remote-protocol.ts`（558 行）：帧二进制布局（streamId@4 / seq@8，与 crypto AAD 字节对齐）；open|data|end|reset|ping|ack 状态机；HTTP/WS ↔ stream 映射；per-stream 流控窗口；版本协商
- [x] Transport Contract 协议层语义覆盖（HTTP 流式、WS 双向、背压、二进制安全）
- [x] 测试：crypto 39 + no-buffer 2 + protocol 46 = **87 全绿**；篡改 header / 重放 / 乱序 / 跨 stream nonce / 版本降级全部对抗测试，变异验证真能 bite；流控窗口耗尽→暂停→ack→恢复非 happy-path
- [x] 验收：87/87 绿、biome 530 文件 clean、tsc exit 0；flake（全局 Buffer 污染）已修（no-buffer 测试隔离独立文件 + try/finally restore），**独立 45/45 进程级循环零失败**；全仓 1396 测试通过

### M2 — Gateway 服务 + 部署管线 — 🟡 代码+测试完成（commit 4f3909b 脚手架 / 99fff2e 实现）；部署管线 + live 验收待 owner deploy

- [x] D1 schema：users（oauth 身份）、daemons、devices、sessions、revocations（`gateway/migrations/0001_init.sql` + `db.ts`；身份键 (provider,provider_sub) 永不用 email；daemon token/code 仅存 sha256 hash）
- [x] OAuth：GitHub code flow + Google OIDC → HS256 会话 JWT cookie；首次登录即建账号（state 单次+cookie 绑定、PKCE S256、Google nonce、id_token JWKS 验 iss/aud/nonce/exp、open-redirect 白名单）
- [x] daemon 绑定流：`POST /daemon/code` 一次性短 TTL 码 → 浏览器登录确认（无 session 401，daemon 不能自批）→ `POST /daemon/token` 换长期 token（原子单次消费）
- [x] `relay-do.ts`：每账号 DO（WebSocket Hibernation API）；daemon token / phone session 双向鉴权、**跨账号 daemonId 拒绝（IDOR 闸）**、opaque 转发（不解密）、吊销即断
- [x] bundle 分发：`/assets/<version>/*`；登录页 + 机器列表 + 配对引导 + `/privacy` + `/terms`
- [x] 限速：登录/approve/码交换 滑窗（per-IP + per-account，approve 防 key-poisoning）
- [x] 测试（vitest-pool-workers，真 workerd）：**144 测试全绿**；provider URL 可注入 → OAuth 端到端零真实网络;关键不变量**变异验证真 bite**(跨账号 IDOR、JWT alg pin、OAuth state CSRF);独立 40/40 + 12/12 进程级零 flake。独立验证逮到并修复 2 条假 alg-pin 测试(缺 required claim 掩盖了 pin)
- [ ] `.github/workflows/gateway-deploy.yml`：手动 deploy + release tag 上传 bundle —— **待做**（与 live 验收配对，需 owner 在 GH secrets 配 `CLOUDFLARE_API_TOKEN` + wrangler.toml 填真 `database_id`）
- [ ] 验收：staging 域名真账号走通 GitHub + Google 登录，wrangler tail 无错误 —— **待 owner**：`wrangler d1 create` 填 database_id → `wrangler secret put` 五个密钥 → `wrangler deploy` → 挂自定义域 `app.hivehq.dev`

### M3 — daemon 远程客户端 — ✅ 完成（commit e4f803f）

- [x] `hive remote login`：打印 gateway URL + 一次性码 → 轮询 `POST /daemon/token` 换 daemon token → 存 app_state（+ `status|logout|devices|revoke`）
- [x] `remote-tunnel.ts`：开关开启且已登录时维持出站 wss（`/relay/daemon` + `Sec-WebSocket-Protocol: bearer.<token>`，对齐 M2）；指数退避重连、心跳、连接状态、generation 守卫防陈旧 socket
- [x] mux 流桥接：HTTP 流 → 回环 `127.0.0.1:<port>` 真实请求（**白名单仅 `/api/*` + `/ws/terminal/<id>/{io,control}` + `/ws/tasks/<id>`，其余 reset+审计**；`/api/ui/session` 硬拒不让远程铸主 cookie；per-boot 内部密钥头常量时间比较 + `x-hive-remote-device` 标签）；WS 流 → 回环 ws 双向管道；`local-request-guard.ts` 未改
- [x] **审计采集层就位**：桥接处统一发 HTTP endpoint/result/reject + WS input 字节数/截断预览 → `remote-audit-store.ts`（异步不阻塞）
- [x] E2E 完整性（invariant 5）：每帧先 `openNext`（AEAD + seq 重放守卫）**再信任路由**；开不出的帧(篡改/重放/未知设备)drop+审计、绝不桥接;`DeviceSessionProvider` 接缝(M4 接真配对)
- [x] 测试（主仓 vitest，进程内 fake gateway 用真 ws；**终端 WS 经隧道用真 PTY 不 mock**）：隧道转发 `GET /api/workspaces` == 本地直连;白名单外/traversal/编码/`/api/ui/session` 全拒;断线退避重连;吊销(控制帧/4401-4410/本地)即断+latch;篡改帧 drop。**全量 1538 测试绿（关闭=零回归）**
- [x] 独立验证：路径白名单 + per-boot 密钥**变异验证真 bite**;逮到内部密钥测试缺口(同长度内容比较被长度检查遮蔽)并补强同长度翻位用例
- [ ] 验收（live，待 M2 部署后）：真 gateway 上 curl 经隧道全 API 可用且白名单外全拒 —— 当前已用 fake gateway 全覆盖;真 gateway 验收并入 M2 live 部署
- [ ] Windows CI：纯 JS 无新原生依赖，待 push 后 CI 确认（本地全绿）

### M4 — 配对 + 设备管理端到端 — ✅ 完成（commit 2fb274b）

- [x] `remote-pairing.ts` + `routes-remote.ts`：短 TTL 一次性配对 token（`PAIRING_TTL_MS=120s`，懒过期+一次性守卫）→ 配对码 payload `{gatewayUrl,daemonId,pairingSecret}`；daemon 侧 `deriveDaemonSession` + SAS + pending 状态机
- [x] Settings "Remote access" 区块（`web/src/remote/`）：开关、登录状态、Add device→配对码、设备列表(名/最后活跃/吊销)、审计流水查看
- [x] **桌面确认弹窗**(`RemotePairingConfirm`)：显示设备名 + 6 位 SAS,确认才落库;拒绝/超时即废。**信任根:begin/confirm/reject 仅本地桌面;tunnel-tagged 请求路由层 403 + bridge 层 path_denied 双重拒(防御纵深)** —— 变异验证真 bite
- [x] `remote-device-store.ts` + **schema v24**(v23 已被 M3 remote_audit 占;设备 store 用 v24);持久化 `DeviceSessionProvider` 替换 InMemory,未确认/已吊销 → `get()` 返 null;密钥材料不入 list/get 投影(secret hygiene)
- [x] 吊销闭环:本地吊销 → provider 立即 null + tunnel 关该设备 live 流(真 PTY)+ 审计;新流拒;tombstone 幂等不可 un-revoke
- [x] 测试:配对 token 一次性/过期;未确认设备无法建流(接 M3 桥);**MITM 换公钥 → SAS 发散 + p2d 发散**(真手机 peer 从 daemon 传输的 pubkey 派生,非复制 → 防空洞);吊销后既有流断/新流拒;审计行真实(非自喂)。**主仓 1622 + 网关 144 全绿(关闭=零回归)**
- [x] 独立验证:信任根路由 gate 变异 bite;全量门禁 + biome 612 我亲自复跑
- [ ] **配对传输 = Option B(M4 模拟,网关字节不变)**:真手机输入配对码 → 桌面确认的 **live 端到端验收并入 M5**(真手机 UI + 真 gateway 配对 relay 通道一起做)。当前用模拟手机 peer 全覆盖协议+确认+吊销

### M5 — Responsive shell + 等权 UI（工作量最大的 gate）— 拆成 M5a（管道,✅ commit 1a0a214）+ M5b（UI,⬜ 进行中）

**M5a — 传输 + 连接管道（✅ 完成）**
- [x] `ApiTransport` 抽象落地，`api.ts` + 终端/tasks WS 客户端切到接口；桌面 DirectTransport **字节级零变化**（既有 web 全绿）；boot 选择 Direct(桌面)/Tunnel(gateway 域)
- [x] `TunnelTransport`：E2E 帧 ↔ fetch + WS；断线 banner + 重连(auth-fatal revoke latch) + 刷新静默重建;in-flight 断线快速失败。**纠正:不用 cookie jar** —— 隧道 /api 由 daemon per-boot 内部密钥鉴权(M3),`/api/ui/session` 对隧道硬拒,手机不持 UI token(计划早期的 cookie jar 设计被 M3 内部密钥模型取代,workflow verify 抓出并删除)
- [x] WS query(clientId/cols/rows)走 `StreamMeta.ws.query`(白名单拒 path 含 `?`),daemon bridge `appendQuery` 回贴回环 URL
- [x] 网关:配对 relay 通道(未配对手机仅配对帧,`relayPair` = `relayDevice` 结构性反面,跨账号门同源,点对点不广播)+ `/pair/confirm`(daemon-token 鉴权,唯一建行者)+ `/pair/session`(确认后 + 单次 jti 绑定才铸 device session,revoke-old-first)+ `/pair/machines`(账号隔离);migration 0002
- [x] 手机配对客户端(`deriveDeviceSession`,SAS,持久化 session 供刷新)+ ConnectView 流层(登录→机器列表→选机/配对)
- [x] 独立验证:web 1671 + 网关 163(M2 的 144 保住)全绿;信任根(`/pair/confirm` 鉴权)+ 未配对手机只能配对,变异 bite

**M5b — Responsive shell + 等权 UI（✅ commit c5f69cd）**
- [x] **移动 add-workspace 负向测试**：`AddWorkspaceFlow` 按布局选面;移动走 `ServerBrowseAddWorkspace`(手动路径 + `/api/fs/browse` + `/api/fs/probe`),**禁 `/api/fs/pick-folder`** —— 负向测试变异 bite
- [x] `MobileShell`：team/tasks 底部导航 + 全屏区,承载现有组件;窄屏 → shell,宽屏 → 现有三栏**字节级不变**(desktop-layout-unchanged 测试)
- [x] 逐组件触屏适配(Parity Matrix 每行有测试):WorkerCard hover cluster → 可见 44px 按钮(Stop/Restart 仅移动);workspace 切换 sheet;TaskGraph 全屏页;Workflows drawer 保留移动全屏组件形态但不进当前底部导航;Settings 入口保留在 topbar;toast 避让底栏
- [x] **终端可写**：直接聚焦 xterm 输入;移除独立 composer/keybar/粘贴确认行;WebGL → canvas 降级(detectWebglSupport)
- [x] **IME**:compositionstart/update/end 单次提交进 sendInput(jsdom 测试覆盖);**真机验证(iOS Safari + Android Chrome)并入 live 验收**(代码已就位)
- [x] ConnectView 视觉皮肤(login/machines/selecting/pairing/connected + SAS hint)+ 本地能力替代:open-in-editor → host 执行 + 手机 toast;剪贴板与终端 stdin 分离
- [x] i18n 全 key en+zh(覆盖测试过);Parity Matrix 每行至少一个 reachability 测试
- [x] 独立验证:全量 1809 绿、biome 685、flake 0/30、6 个 functional-cut/回归 blocker 逐一代码层确认修复
- [ ] 验收（live，并入 M2 部署）：真手机 4G **等权流程** + 真 gateway 配对(M4 deferred 的真机配对码→桌面确认在此真跑)+ IME 真机

### M6 — 生产加固 — ✅ 完成（commit 4a6cd1d，含 M6.1 critical 修复）

- [x] 会话生命周期：phone 会话过期/续期、heartbeat pong 截止、4404 离线重试上限
- [x] 弱网长尾：in-flight 请求隧道中断快速失败(不悬挂);终端流重连取快照(onClose 接线 + reconnect epoch 重挂);**有界背压**(per-stream 发送侧 FlowController + io self-ack 受窗口门控 → 慢手机暂停 PTY 而非撑爆 daemon 内存)
- [x] 新远程会话 → 桌面通知(现有 notifications 通道,desktop-only,en+zh)
- [x] 安全复查:全链对抗式审计(5 镜头)。**抓到并修复 5 个确认漏洞**,含 **VULN-CRYPTO-1(critical)**;loopback 头清洗(剥 host/origin/cookie/x-forwarded/hop-by-hop,tunnel 头最后 stamp,堵头走私);其余路径白名单/IDOR/secret 经核查无新漏
- [x] **M6.1 critical:per-connection rekey** —— 持久密钥曾作裸 AEAD key,页面刷新(新 mux,seq/streamId 归零)致 channel Hello `nonce(p2d,0,0)` 跨刷新重用。修:持久密钥降级为 root,每连接 `HKDF(root, phoneSalt‖daemonSalt)` 派生专用密钥(unsealed 交换 salt,connKey 下 seal 绑定 Hello,trial-open 解析设备)。**no-(key,nonce)-reuse 回归(跨刷新同一 root)变异验证真 bite**(去 rekey → B1/B4/B5/B6 全挂)
- [x] 压测脚本:单 daemon 多设备并发 + 终端高吞吐经隧道(`scripts/remote-stress-*.ts`,`pnpm stress:*`);`docs/remote-stress.md`
- [x] Windows-compat:确认无新原生依赖、remote-* 模块无文件路径;relay URL 收紧为纯数字 loopback;`run-windows-tests.mjs` include 扩充
- [x] gateway bundle SRI:byte-verified 资产 + SRI-pinned loader + require-sri-for CSP(12 测试);诚实标注 loader 自身 TOFU 局限
- [x] 独立验证:主仓 1898 + 网关 175 + biome 705 全绿;**workflow 首版漏修 CRYPTO-1 且 verify 误判,我逐文件查证确认漏洞为真 → 专项修复 → 变异坐实**(详见提交说明)
- [ ] 验收(deferred manual):72h 挂机(daemon + 真手机)、真 Windows CI(需 push)、无泄漏/无僵尸流/断网恢复

### M7 — 文档 + 决策记录 + 发版

### M7 — 文档 + 决策记录 + 发版

**M7 代码/文档（✅ commit df5ceb3）**
- [x] `docs/remote-access.md`：用户指南（开启、`hive remote login`、配对码→桌面 SAS 确认、手机 UI、吊销、self-host gateway）
- [x] `docs/design-decisions.md`：non-goal 反转记录 + **Authority Model 原文收录** + why-no-worktree/heartbeat/global-team/auto-resume
- [x] `CLAUDE.md` 决策表更新（远程访问形态/权限模型/gateway 归属 3 行）；`CLAUDE.md` 标注 gateway 公开源码、独立部署 + 反转记录
- [x] README（zh+en）Remote 区块（可选、需 gateway、默认关，措辞准确不过度宣称）；What's New 2.0.0 已提升为 `web/src/whats-new/changelog.ts` live 顶条
- [x] `.github/workflows/gateway-deploy.yml` + `docs/deploy-runbook.md`（owner wrangler 步骤 + live 验收清单）+ `scripts/gateway-bundle-manifest.mjs`（SRI manifest）
- [x] public-safety 审计:无 private 泄漏入公开文档(修了"gateway 在本仓"过度宣称 + 死链);准确性:诚实标注 `hive remote devices/revoke` 尚未对接 hosted gateway(设备管理在 Settings)

**M7 发版（⬜ owner-gated，依赖 live gateway）**
- [ ] Google OAuth 生产审核通过确认（周级外部审核）
- [ ] 发版 `2.0.0`：bump version + changelog + 提升 whats-new 草案为 live 顶条 + 走 `docs/release.md` 全流程（tag/publish）—— **等 gateway 部署 + live 验收后再做**
- [ ] 验收：新用户按 `docs/remote-access.md` + `docs/deploy-runbook.md` 从零完成全流程

**~~已知小缺口~~（✅ 已修 commit 4497583）**:`hive remote devices/revoke` 原打的是不存在的网关路由(404)。已重设计为**直接操作 daemon 本地设备 store**(源头真相,与 login/status 同模式)—— 本地 revoke 才真正让 daemon 停止解密该设备流量。CLI revoke 在设备下次连接时拒绝;in-progress 会话用 Settings 即时断开。

---

## Threat Model 摘要（M6 安全复查的对照表）

| 威胁 | 防线 |
|---|---|
| 账号被盗 = 本机 RCE | OAuth 之上叠设备配对（新设备必须桌面确认）+ 吊销 + 审计 + 新会话桌面通知 |
| gateway 读用户数据 | E2E：gateway 只见密文；局限（web 分发 crypto）如实写文档 |
| gateway 被攻破 | 爆炸半径 = 拒绝服务 + 恶意 bundle（SRI/版本化缓解）；不能解密历史流量（会话密钥前向派生） |
| 隧道被当通用内网代理 | 回环桥接路径白名单仅 `/api/*` `/ws/*`，白名单外 reset + 审计；负向测试硬性覆盖 |
| 配对码泄露 | 短 TTL + 一次性 + 桌面确认仍拦截 |
| 已配对手机铸造新设备 | 配对审批仅桌面可批（信任根），远程审批必拒 |
| 回环代理头伪造 | per-boot 内部密钥头，仅 daemon 进程内知晓 |
| 重放/篡改帧 | AEAD + 单调 seq，M1 测试硬性覆盖 |

## 明确不做（本计划范围外）

- LAN 直连模式（单通路原则）
- 多用户/团队共享、协作授权
- 原生 App、系统级推送（webhook → ntfy/Bark 已覆盖）、语音
- 手机专属权限系统 / 隧道层按钮级权限裁剪（移动壳可做已记录的入口与危险快捷按钮取舍）
