# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

ShrimpBot 是 飞书 (Lark) ↔ Claude Code 的实时通信桥，围绕**同一个** Claude Code 实例把 I/O 同步到三个端：终端（TUI 透传）、飞书（交互卡片）、Web（浏览器终端，WebSocket）。

驱动 Claude 有**两条路径**，默认走 PTY：

| | PTY 路径（默认） | SDK 路径（`SDK_EVENT_MODE=true`） |
|---|---|---|
| 机制 | `node-pty` spawn `claude` 子进程，解析终端字节流 | `@anthropic-ai/claude-agent-sdk` 的 `query()`，拿结构化 `SDKMessage` |
| 飞书数据源 | `output-parser.ts` 正则从 TUI 文本里**猜**语义 | `sdk-session.ts` 直接读 `msg.type`，零歧义 |
| Web 显示 | PTY raw ANSI | SDK 事件流（方案 C） |
| A2 权限审批 | ✅ 已接入 | ❌ **未接入**（`onApproval` 无条件 allow） |

> **前置依赖**：Claude Code CLI ≥ **v2.1.47**（`Stop` hook 依赖该版本引入的 `last_assistant_message` 字段）、Node 20+。Linux/macOS 编译 `node-pty` 需 `python3 make g++`。
> 当前版本 **v1.4.0**（A2 权限审批 + 方案 C + Docker hub）。

## 构建与开发命令

```bash
npm install && npm run build   # tsc 编译到 dist + npm link（注册全局 sbot CLI）
npm run dev                    # build 后直接跑 dist
npm start                      # 跑已编译的 dist
npm test                       # vitest run --exclude '**/e2e*'
npm run test:e2e               # e2e（spawn 真实 claude PTY）
```

跑单个文件 / 单个用例：

```bash
npx vitest run src/pty/__tests__/output-parser.test.ts
npx vitest run -t "detects yes/no"
```

测试分布在**两处**，vitest 都跑（共 8 文件 42 用例）：

- `tests/` —— legacy 路径（`master` / `bot` / `session` / `feishu`）
- `src/**/__tests__/` —— `output-parser`（解析器噪声过滤/完成检测/yes-no 判定）、`sdk/*`（`approval-gate` 5 例、`feishu-card-renderer` 7 例、`sdk-session.integration` 2 例）

注意：

- `tsconfig.json` 只 `include: ["src/**/*"]` 且 `exclude` 了 `tests/` ——`tests/` **不参与 tsc 编译**，仅由 vitest 直接转译运行。所以 `npx tsc` 通过不代表 `tests/` 没问题。
- `src/sdk/__tests__/sdk-session.integration.test.ts` 是**真实 API 集成测试**：需要 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_BASE_URL`，否则整块 `describe.skip`（静默跳过，不报错）。启用时耗时约 23s，占 `npm test` 总时长的绝大部分。
- E2E 测试假定 CLI 装在 `/home/grigs/.local/bin/claude`。

## 架构

### 入口分发（`src/index.ts`）

`main()` 按以下**优先级**判定运行模式：

1. **`init` 子命令** → `handleInit()`。带齐 `--app-id --app-secret` 走非交互写配置，否则进 `setupWizard()` 交互向导。
2. **`--web-server`** → 独立 Web hub（仅 Web UI + Hook API，**不起 PTY / 不连飞书**）。
3. **`FEISHU_MODE=bridge`** → 完整三端 `FeishuBridge`。内部子分支：
   - 无飞书凭证 + `--web` → 降级为 web-only 模式（PTY + Web，无飞书）
   - 无凭证且无 `--web` → 自动进 `setupWizard()`
4. **`FEISHU_MODE=master`** → 旧多 bot 进程管理器（deprecated）
5. **默认 `single`** → 旧 `MCPServer`（`src/server.ts`，stdio，deprecated）

> 默认 mode 其实是 `'single'` 而**不是** bridge。bridge 靠 `.sbot` 里的 `FEISHU_MODE=bridge`（`sbot init` 会写入）或显式 env 触发。
> `.sbot` 在模式判定**之前**加载，且**不覆盖已存在的 env**（即 CLI/env > `.sbot`）。
> `parseArgs()` 只解析 `SBOT_FLAGS` / `SBOT_OPTIONS` 里列出的自有参数，**其余参数原样透传给 Claude Code CLI**。改参数解析时注意保持这个透传语义。

### 两条路径的共存关系（易踩坑）

SDK 路径**不是**独立模式，而是 `FeishuBridge` 内部的 feature flag（`feishu-bridge.ts:218` 读 `SDK_EVENT_MODE === 'true'`）。二者**不互斥**：

- SDK 模式下 PTY **照样** `pty.start()`（`feishu-bridge.ts:228`）——PTY 进程始终存在。
- 分流只发生在飞书消息入口 `dispatchToClaude()`（`feishu-bridge.ts:600`）：`sdkMode && sdkSession` 时走 SDK 并 `return`，否则落回 PTY 路径（旧路径在 flag 关闭时"完全不变"）。
- **Web 输入仍写 PTY**（`pty.writeRaw`），只有 Web 的**输出侧**被 `sdkWebBroadcast` 替换。所以 SDK 模式下 Web 输入与 SDK 显示通道是**分离**的。

SDK 路径目前是 MVP 状态，已知缺口：

- A2 审批未接入：`feishu-bridge.ts:497` 有显式 `// TODO: 阶段 B 接入 ApprovalGate 飞书交互卡片`，`onApproval` 对非 clone 模式无条件 allow。
- 无会话续接：只调 `SDKSession.start()`，从不调 `resume()` —— 每条飞书消息都是全新会话，跨消息无记忆。
- 无故障降级：SDK dispatch 异常只 patch 红卡，不会回退 PTY。

### 核心组件

| 文件 | 角色 |
|------|------|
| `src/pty/feishu-bridge.ts` (~1650 行) | **主编排**。PTY 生命周期、飞书 WSClient、消息队列、卡片流、A2 审批桥接、SDK 路径接线。 |
| `src/pty/web-server.ts` (~1450 行) | Express + 双 WebSocketServer（`/` 浏览器、`/ws/bot` bot provider）。**Hub 与认证中枢**。 |
| `src/pty/pty-manager.ts` | `node-pty` 封装。spawn 参数、raw 数据流、退避重启、`markNewRound()`。 |
| `src/pty/output-parser.ts` | 用 `ghostty-opentui` 把 ANSI 渲染成文本，再靠正则过滤 TUI 噪声（边框/状态栏/进度）。检测 `●` 完成标记与 yes/no 提问。 |
| `src/pty/hook-settings.ts` | 自动写 `.claude/settings.local.json` 的 hooks 配置（见下）。 |
| `src/sdk/sdk-session.ts` | 封装 `query()`/`resume()`，产出 `SDKBridgeEvent` 流。 |
| `src/sdk/approval-gate.ts` | 8 行的 `classify()`：只把 `AskUserQuestion` 判为 `question`，其余全 `allow`（"等效 bypass"）。 |
| `src/sdk/feishu-card-renderer.ts` | 纯状态机，SDK 事件 → `CardState`。**不发飞书**，发送仍复用 `FeishuBridge.patchCard()`。 |
| `src/config.ts` | 配置加载 + 凭证优先级解析。 |
| `src/setup.ts` | `sbot init` 交互向导。 |
| `src/logger.ts` | 文件（按天）+ stderr 双写。`ptyRaw()` / `parseResult()` 是只写文件的 debug 专用通道。 |

**Legacy（deprecated，勿在其上开发新功能）**：`src/server.ts` (`MCPServer`) → `src/bot.ts`（single 模式 stdio 循环）→ `src/master.ts`（master 模式进程管理 + `/route` HTTP 路由）；配套 `src/services/`、`src/handlers/`、`src/capabilities.ts`、`src/types/index.ts`。

**复杂度集中点**：`feishu-bridge.ts` 与 `web-server.ts` 两文件占了几乎全部编排与三端同步逻辑。排查数据流或卡片状态从这里入手。

### 配置体系

**配置文件（`~/.shrimpbot/`）**

| 文件 | 内容 |
|---|---|
| `bots.json` | Bot 注册表：`[{name, appId, appSecret, chatIds?}]` |
| `config.json` | 活跃 bot（`activeBotName`）、`chatIds`、`claudeCwd` |
| `users.json` | Web 登录用户 `{id, username, display_name, role}`，登录时 upsert |
| `settings.json` | Web 设置：`web_port` / `log_level` / `session_secret` / `yz_login_url` / `service_url` |
| `commands/{botName}.json` | 每只 bot 的常用命令（命令面板） |
| `logs/shrimpbot-YYYY-MM-DD.log` | 按天分文件日志 |

**单 bot 凭证优先级**（`loadSingleBotConfig`，`src/config.ts:112`）：env `FEISHU_APP_ID`+`SECRET` → `FEISHU_BOT_NAME`/`activeBotName` 查 `bots.json` → `bots.json` 首项 → 空（触发向导或报错）。

**`.sbot`（项目级，`KEY=VALUE`，注入 `process.env` 但不覆盖已有值）**。常用键：`FEISHU_MODE`、`FEISHU_BOT_NAME`（绑定本目录用哪只 bot）、`CLAUDE_CWD`、`CLAUDE_PATH`、`CLAUDE_EXTRA_ARGS`、`SDK_EVENT_MODE`、`WEB_PORT`、`WEBSERVER_HOST`、`WEB_NO_AUTH`、`LOG_LEVEL`、`DEBUG`、`YZ_LOGIN_URL`、`YZ_LOGIN_APP_ID`、`SERVICE_URL`、`SESSION_SECRET`。

> **绝不读写 `.env`。** 项目级配置一律走 `.sbot`。（仓库根目录仍存在一个 `.env`，但已被 `.gitignore` 忽略，不要回退到它。）

### 三端同步（核心不变量）

三端共享**同一个** Claude Code 实例。改动数据流必须保住这个不变量。

**显示（Claude 输出 → 三端）**

- **终端**：PTY raw ANSI 直接写 `process.stdout`（透传模式，`setRawMode(true)`）。
- **Web**：PTY raw ANSI 经 WebSocket 广播给所有浏览器（xterm.js 渲染）。**SDK 模式下**改为广播 SDK 事件流。
- **飞书**：PTY 数据经 `OutputParser.parse()` 提干净文本 → 交互卡片（🔵 思考 → 🟢 完成 / 🟡 选项 / 🔴 错误）或 clone 模式纯文本。SDK 模式下改由 `FeishuCardRenderer` 生产内容。

**操作（任一端输入 → Claude）**

- 终端 stdin / Web WS / `POST /api/send` → `pty.writeRaw()`（Enter 时 `markNewRound()`）→ PTY
- 飞书消息 → `pty.send()`（`markNewRound()`）→ PTY
- **SDK 模式下飞书消息** → `dispatchToClaudeViaSDK()` → `SDKSession`，**不经 PTY**

**投递到 PTY 的两个坑（已在代码里处理，改这块别踩回去）：**

1. **多行必须分两次写。** `PTYManager.send()` 对含 `\n` 的文本先写文本、80ms 后单独写 `\r`。合成一次写会被 claude TUI 判定为**粘贴**，结尾 `\r` 成为字面内容而不提交 → 消息停在输入框要人工回车。单行仍是一次写 `text + '\r'`（行为不变）。终端手动粘贴的 bracketed paste（`ESC[200~…ESC[201~`）由 `writeRaw` **原样透传**，不要剥标记——剥了会让粘贴内容里的换行全部变成有效提交。
2. **新消息要过 `ReadyGate` 等 `❯` 就绪。** 启动/恢复会话期间 TUI 未就绪，盲写的 `\r` 会被初始化流程吞掉。门闸 30s 超时 fail-open（绝不挂住消息）。**只用于新消息派发**（`deliverText()`：飞书消息、`--command` 首条命令）；**A2 的 AskUserQuestion 回答与 yes/no 回答绝不能过门闸**——那时 claude 停在 TUI 里不显示 `❯`，会白等到超时。

**规则**

- **不重复**：每端只收一次。飞书侧靠 `streamBuffer` 增量 diff，完成时只发剩余 delta。
- **不漏发**：`firstMessageReceived` 在任何一端收到第一条真实文本输入时置 `true`；只有置位后 Claude 输出才转发飞书（拦掉启动噪声）。
- **格式适配**：终端/Web 拿 raw ANSI，飞书拿解析后的纯文本。
- **状态复位**：所有输入路径在 Enter 时调 `markNewRound()` 复位 `OutputParser`。`handleExternalCommand()` 与 `dispatchToClaude()` 还会重置 `streamBuffer` / `fallbackPtyText` / `lastTranscriptPath`。

### Hook 事件

`hook-settings.ts` 会往当前工作目录的 `.claude/settings.local.json` 写入 7 个 hook。它**只合并 `hooks` 字段、保留用户已有配置**，并且写入前会先过滤掉旧的 shrimpbot hook（按 command/url 含 `/api/hook` 或 `shrimpbot` 标记识别），所以既不会覆盖别人的 hook，也不会重复堆叠自己的。

| Hook | 类型 | 用途 |
|---|---|---|
| `Stop` | command | 任务完成，更新卡片终态 |
| `Notification` | command | Claude 主动通知 |
| `PostToolUse` | command | 工具成功 → "🔄 处理中"中间态 |
| `PostToolUseFailure` | command | 工具失败 |
| `SubagentStop` | command | 子代理完成 |
| `SessionStart` | command | echo 一段 `additionalContext`，引导 Claude **优先用 `AskUserQuestion`** 而非纯文本编号列表（结构化选项飞书端才能可靠识别） |
| `PermissionRequest` | **`http`（同步阻塞）** | **A2 权限审批**。timeout **330s** |

> `PermissionRequest` 的 timeout 必须 **> 审批链路的 5 分钟超时**（hub `pendingApprovals` 与 bridge 挂起都是 300s）。否则 HTTP 先超时会变**非阻塞**，绕过 A2 直接走默认权限流程。改任一侧超时都要同步另一侧。

在非 clone 模式下，`doFinalPatch()` **优先用 `fallbackPtyText`**（`OutputParser` 产出、保证是本轮内容），transcript 文件仅作 fallback（其中可能残留中间 Stop 的过期数据）。

### A2 权限审批

`pty-manager.ts` 已**去掉 `--dangerously-skip-permissions`**，claude 以 default 权限模式启动，于是 `PermissionRequest` hook 能被触发。`classify()` 决定每个工具的走向：

- **普通工具**（Bash/Write/Read/…）→ `allow` → hub 立即放行，**等效 bypass，不审批不卡顿**。
- **AskUserQuestion** → 转发飞书**结构化选项卡片**。

```
claude 调工具 → PermissionRequest hook(http) → POST hub /api/hook/approval?bot=X
  ├─ 普通工具 → classify=allow → 立即放行
  └─ AskUserQuestion → classify=question → WS approval-request → bridge
        → 飞书 🟡 选项卡片
        → 用户回复编号/选项名 → 解析为 label → sendToPty(label)
        → claude 的 AskUserQuestion TUI 收到 → 按选择继续
```

**两条必须遵守的约束**（都来自实测踩坑）：

1. **答案必须经 PTY 投递，不能用 `updatedInput` 注入。** `PermissionRequest` 在工具执行**前**触发，而 AskUserQuestion 的答案是工具的**结果**而非**输入参数**——此时无答案可注入。所以 bridge 收到请求后先**立即回 allow** 让 claude 进入 TUI 等待，用户回复时再写 PTY。
2. **启动时不要带 `-c` / `--resume`。** 会续上一个 bypass 会话（或同 cwd 下别的 bypass 会话），继承 bypass 权限模式 → `PermissionRequest` 不触发 → **A2 整体失效**。必须全新 default 会话。

失败路径**一律 fail-closed**：bot 未连接、5 分钟超时、WS 断开、server 停止，全部 deny。这条设计要保住。

SDK 路径另有 `HIGH_RISK_TOOLS` 硬黑名单（`rm` / `sudo` / `dd` / `mkfs` / fork 炸弹 / `shutdown` / `docker run`），经 `disallowedTools` 传给 SDK，连问都不问。

### Web 服务与鉴权

**两种形态**：独立 hub（`--web-server`，不传任何 PTY deps）与内嵌（bridge / web-only，把 PTY deps 注入 `WebServer`）。hub 形态下本地终端能力退化：`/api/buffer` 返回空、`/api/send` 返回 503，终端数据全靠远端 sbot 经 `/ws/bot` 接入。端口统一 `WEB_PORT`，默认 **5554**（`EADDRINUSE` 只警告不退出）。

**HTTP 路由要点**：`/api/status`、`/api/hook`、`/api/hook/approval` 公开；`/login` `/callback` `/logout` `/api/auth/user` 是 SSO 流程；`/`、`/api/buffer`、`/api/send`、`/api/commands/*` 需登录；`/settings`、`/api/admin/*` 需 admin。

**WebSocket 协议**：

- `/`（浏览器）：服务端发 `auth-ok` / `bot-list` / `pty-data`；浏览器发 `web-input`（带 `targetBot`）/ `select-bot`。
- `/ws/bot`（sbot provider）：provider 发 `bot-join` / `pty-data` / `approval-response`；hub 发 `web-input` / `hook` / `approval-request`。

**鉴权（注意边界，不要假设它很严）**：

- yz-login SSO：`/login` 302 跳转 → 带 ticket 回调 → `verifyTicket()` → `upsertUser()` 写 `users.json` → 写 session。`/logout` 必须同时跳 SSO 登出，否则会被立刻重新发 ticket。
- 角色只有 `admin` / `user`，**SSO 的 `is_admin` 被忽略**，只认本地角色。`grigs` 是硬编码超级管理员，不可降级、不可删除。
- **`requireAuth` 实际上也要求 admin**（`web-server.ts:157`）——普通 `user` 角色登录后连 `/` 都打不开，角色模型目前退化为"admin 能进、user 白登录"。
- **`/ws/bot` 与浏览器 WS 都没有真正的鉴权**：非 noAuth 模式下 WS 直接标记为已认证（不看 cookie），`/ws/bot` 允许任何人 `bot-join` 冒名注册。能连到端口即可收发 PTY 输出与 `web-input`。这是已知的架构短板，涉及改动时不要把安全依赖建在它上面。
- `--no-auth` 会放行一切鉴权（含 WS），整个 Web 终端等同零门槛远程 shell，仅限内网/开发。

### 命令面板 / 多咪

- 命令存储：`~/.shrimpbot/commands/{botName}.json`，结构 `[{label, command}]`。Web UI 右下角浮层支持勾选批量发送、快速添加、导入/导出 JSON。API：`GET/POST/DELETE /api/commands/:botName` + `/export` + `/import`。
- 多咪：`sbot init` 注册 bot 到 `bots.json`；每个项目的 `.sbot` 用 `FEISHU_BOT_NAME=<name>` 绑定，因此多个终端可同时跑不同 bot。
- 新群聊/私聊自动发现并写回该 bot 的 `chatIds`。消息按 bot 排队，`claudeBusy` 防止并发调用 Claude。
- Hub 拓扑：Docker 起 `--web-server` 当 hub，各 sbot 实例用 `--web-host <ip>:5554` 连上去（`WEBSERVER_HOST` 同理）。未配 `webHost` 时：5554 空闲就自己当 hub，被占则以 provider 身份连 `ws://127.0.0.1:5554/ws/bot`。断线指数退避重连（1s→30s）。

## 部署

**systemd**（单元文件在 `contrib/`）：

```bash
sudo cp contrib/sbot-web.service /etc/systemd/system/
sudo systemctl enable --now sbot-web
systemctl status sbot-web        # 查状态
```

`contrib/` 下三个单元分别对应 `--web-server` / `--web` / 无参数全功能。

**Docker（WebServer hub）**：生产推荐单独跑 hub，各 sbot 实例连上去。

```bash
npm run build                                  # 必须先编译出 dist
docker build -t shrimpbot:v1.4.0 .
docker save shrimpbot:v1.4.0 | gzip | ssh user@prod 'gunzip | docker load'
# 生产机：cd /opt/sbot && docker compose up -d
```

Compose 关键点：`CMD node dist/index.js --web-server`（hub 不启动 PTY/飞书）；挂载 `~/.shrimpbot`（提供 users.json / settings.json）；**不需** claude CLI / 飞书凭证 / `SDK_EVENT_MODE`。多平台兼容注意：`node-pty` 需在**目标平台**构建，跨平台镜像不通用。

> 本机更新代码后需 `sudo systemctl restart sbot-web`（或重启容器）才会生效。

## 调试

- `~/.shrimpbot/logs/shrimpbot-YYYY-MM-DD.log` —— 全部日志，含 PTY raw 数据（`ptyRaw()`）与解析结果摘要（`parseResult()`），均为 debug 级且只写文件。
- 开 debug：`sbot --debug` 或 `LOG_LEVEL=debug`。
- `.claude/settings.local.json` —— 当前 hooks 配置（由 `hook-settings.ts` 自动维护）。
- `/tmp/shrimpbot-debug.log` —— 仅 legacy MCP 模式的 notification 调试。

## 约定

- **git commit message 必须用中文。**
- **不要主动 push**，除非用户明确指示。
- `npm run build` 含 `npm link`，会把 `sbot` 注册为全局 CLI —— 改完要重跑 build 才能让全局命令生效。
- 改动项目文件时同步更新 `NOTICE`。**注意：仓库当前并没有 `NOTICE` 文件，git 历史中也从未存在过**——这条约定处于失效状态，需要时请先创建。
- `README.md` 是面向用户的中文文档（安装/模式/CLI 参数/部署），改动功能后同步更新。
- 设计文档与实施计划放在 `docs/superpowers/{specs,plans}/`，按 SDD（spec → plan → 实施）流程走。
