# ShrimpBot / 🦐

飞书 ↔ Claude Code 实时通信桥。通过 PTY 启动 Claude Code，实现飞书、终端、Web 三端同步交互。

支持**多群聊**和**单人私聊**同时工作，自动发现新会话并记录。

> **要求**：
> - Claude Code CLI ≥ v2.1.47（PTY 与 SDK 模式均需 `claude` 在 PATH；SDK 模式 spawn claude 子进程）
> - Linux/macOS：`npm install` 需 `python3 make g++`（编译 node-pty）
> **版本**：v1.4.0 — A2 权限审批（去 `--dangerously-skip-permissions`；ApprovalGate 普通工具自动 allow 等效 bypass，AskUserQuestion 走飞书结构化选项卡片 + PTY 投递）+ 方案 C（SDK 模式 Web 显示 SDK 事件流，飞书+Web 同一 claude 实时同步）+ Docker hub 架构 + SSO 集成

## 快速开始 / Quick Start

**前置**：[Node.js](https://nodejs.org/) 20+、[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude` 在 PATH）。Linux/macOS 还需 `python3 make g++`（编译 node-pty）。

```bash
npm install && npm run build
sbot
```

无参数启动 = 全功能（bridge 模式）：自动检测端口、加载配置、启动 PTY + 飞书 + Web 三端。

首次启动或空项目目录自动进入配置向导（选择哪只咪）。也可以用 `sbot init` 手动初始化：

```bash
# 交互式配置
sbot init

# 参数式配置（直接指定凭证）
sbot init --app-id cli_xxx --app-secret yyy --name "小虾虾"

# 指定会话
sbot init --app-id cli_xxx --app-secret yyy --name "小虾虾" --chat oc_xxx
```

或手动在项目根目录创建 `.sbot`（项目级配置）：

```bash
FEISHU_MODE=bridge
CLAUDE_CWD=/path/to/project
```

飞书凭证和会话 ID 通过 `sbot init` 写入 `~/.shrimpbot/`，不需要手动配置。

### 配置层级 / Config Hierarchy

| 层级 | 文件 | 用途 |
|------|------|------|
| **项目级** | `.sbot`（项目根目录） | FEISHU_MODE、CLAUDE_CWD 等环境变量 |
| **全局配置** | `~/.shrimpbot/config.json` | 活跃 Bot、chatIds、claudeCwd |
| **Bot 注册表** | `~/.shrimpbot/bots.json` | 所有 Bot 的 appId/appSecret |
| **环境变量** | 命令行或系统 | 最高优先级，覆盖以上所有 |

## 三端同步 / Three-Endpoint Sync

终端、飞书、Web 三端**同步显示、同步控制**：

| 端 | 能力 |
|----|------|
| **终端** | 完整 Claude Code TUI（透传模式），键盘直接操作 |
| **飞书** | 交互式卡片，选项选择、确认、富文本 Markdown |
| **Web** | 浏览器终端（端口 5554），实时 WebSocket |

### PTY 模式 vs SDK 模式（三端同步差异）

| | PTY 模式（`SDK_EVENT_MODE=false`，默认） | SDK 模式（`SDK_EVENT_MODE=true`，方案 C） |
|---|---|---|
| **飞书消息走向** | PTY claude（`pty.send`） | SDK claude（`query` spawn，独立后台） |
| **Web 显示** | PTY raw（TUI，三端同一 claude）| SDK 事件流（飞书+Web 同一 SDK claude） |
| **Web 输入** | PTY claude（回复 Web 可见） | PTY claude（独立，回复不进 SDK 事件流） |
| **优势** | 三端完全同步（飞书/Web/终端同一 claude）；**A2 权限审批已接入**（ApprovalGate + AskUserQuestion 飞书卡片） | 飞书结构化（无正则/选项误判） |
| **劣势** | 正则解析脆弱（A1 门控缓解） | Web 输入与 SDK 显示通道分离（方案 C 未覆盖 Web 输入）；**A2 审批尚未接入**（onApproval 无条件 allow） |

**选型**：要三端完全同步 + 飞书权限审批用 PTY（默认）；要飞书结构化 + Web 看飞书问答用 SDK（方案 C）。

### 启动逻辑

1. 检测端口 5554 → 没占用就自启 Web 服务，占用就连上去
2. 检测项目配置 → 有就直接启动，空项目自动进 init 选咪
3. 启动 PTY + 飞书 + Web 连接

### 多咪架构

```
systemd sbot-web (独立 Web 服务, :5554)
  ├── WebSocket ← sbot (小虾咪) — PTY + 飞书
  └── WebSocket ← sbot (键盘咪) — PTY + 飞书
      ↑ 未来 Web 端分 tab 显示各只咪
```

## 多群和私聊 / Multi-Chat Support

- **自动发现**：新的群聊或私聊消息到来时，自动记录到 `~/.shrimpbot/config.json`
- **消息队列**：Claude 正在回复时，其他会话的消息自动排队，按序处理
- **精确路由**：每个回复都发到发起提问的会话，不会串聊
- **排队通知**：排队时飞书提示 `⏳ 排队中`

## CLI 参数 / CLI Options

```
sbot [命令] [sbot选项] [claude选项...]

命令:
  init                     初始化配置（交互式或参数式）

sbot 选项:
  --command <文本>          启动后自动发送的命令
  --cwd <目录>             Claude Code 工作目录
  --chat <chat_id>         指定飞书会话 ID
  --debug                  开启调试日志
  --clone                  飞书全量同步模式（所有回复都发飞书）
  --web                    启用 Web 终端
  --web-server             独立 Web 服务（不启动 PTY/飞书）
  --web-host <地址>        远程 WebServer 地址（如 192.168.0.19:5554）
  -h, --help               显示帮助

Claude 选项（全部透传给 Claude Code CLI）:
  -m, --model              指定模型
  --resume                 恢复上次会话
  --allowedTools           限制可用工具
  --max-turns              最大对话轮次
  ... 以及 Claude Code 支持的任何参数

示例:
  sbot                                 全功能启动
  sbot init                            交互式初始化
  sbot --clone                         飞书全量同步模式
  sbot --command "列出文件"             启动并自动执行命令
  sbot --cwd /tmp -m claude-opus       sbot + Claude 参数混用
```

## 模式说明 / Modes

| 模式 | 触发 | 飞书 | 说明 |
|------|------|------|------|
| **bridge**（默认） | `FEISHU_MODE=bridge` 或有飞书凭证 | ✅ | 完整三端：PTY + 飞书 + Web。卡片 🔵思考→🟢完成/🔴错误 |
| `--clone` | bridge + `--clone` | ✅ 纯文本 | 所有回复原样发飞书（非卡片） |
| **SDK** | bridge + `SDK_EVENT_MODE=true` | ✅ | 飞书走 Agent SDK 结构化事件（替代 PTY 正则解析）。**方案 C**：Web 同步显示 SDK 事件流（飞书+Web 同一 SDK claude，实时同步）；终端 PTY 独立 |
| **web-server** | `--web-server` | ❌ | 独立 WebServer hub（仅 Web UI + Hook API），各 sbot `--web-host` 连接 |
| **web-only** | `--web`（无飞书凭证） | ❌ | PTY + Web 终端，无飞书 |
| single/master | `FEISHU_MODE=single/master` | — | 旧模式（deprecated，勿用） |

## Claude Hooks 集成

自动配置 Claude Code hooks 推送事件：

| Hook 事件 | 类型 | 用途 |
|-----------|------|------|
| `Stop` | command | 任务完成，更新飞书卡片 |
| `Notification` | command | Claude 主动通知用户 |
| `PostToolUse` | command | 工具调用成功（Bash/Write/Edit 等发"🔄 处理中"中间态） |
| `PostToolUseFailure` | command | 工具调用出错 |
| `SubagentStop` | command | 子代理完成（发"🔄 处理中"中间态） |
| `SessionStart` | command | 输出 additionalContext，引导 Claude 优先用 AskUserQuestion（结构化选项，飞书端可可靠识别） |
| `PermissionRequest` | **http**（同步）| **A2 权限审批**：hub 阻塞返回 allow/deny（普通工具自动 allow 等效 bypass；AskUserQuestion 转发飞书选项卡片）。timeout 330s |

## 权限审批 / Permission Approval（A2，PTY 模式）

去掉 `--dangerously-skip-permissions`，claude 以 **default 模式**启动（PermissionRequest hook 可触发），由 **ApprovalGate** 决定每个工具的走向：

- **普通工具**（Bash/Write/Read/…）→ `classify` 返回 `allow` → hub 立即放行（**等效 bypass**，不审批、不卡）。
- **AskUserQuestion** → 转发飞书**结构化选项卡片** → 用户回复编号/选项名 → 答案经 **PTY 投递**回 claude → 按选择继续。

```
claude 调工具 → PermissionRequest hook(http) POST hub /api/hook/approval?bot=X
  ├─ 普通工具 → classify=allow → 立即放行
  └─ AskUserQuestion → classify=question → WS approval-request → Code咪
        → 飞书🟡选项卡片（1.xx 2.xx …，结构化渲染）
        → 用户回复"1"/选项名 → 解析为 label → sendToPty(label)
        → claude AskUserQuestion TUI 收到 → 按选择继续
```

**关键约束**：
- 答案**必须经 PTY 投递**——`PermissionRequest` 的 `updatedInput` 只改工具输入参数、不改结果，而 AskUserQuestion 的答案是结果（hook 在执行前触发，无答案可注入）。故 A2 收到请求后**立即回 allow** 让 claude 进 TUI 等待，再于回复时写 PTY。
- 启动 Code咪 **不要用 `-c`/`--resume`**：会续上一个 bypass 会话（或同 cwd 下别的 bypass 会话）→ 继承 bypass 权限模式 → PermissionRequest 不触发 → A2 失效。需全新 default 会话。
- 5 min 无回复：claude 仍在 AskUserQuestion TUI 等待，可从终端/Web/飞书补答。

> ⚠️ **SDK 模式（`SDK_EVENT_MODE=true`）尚未接入 A2**：其 `onApproval` 目前无条件 allow。PTY/SDK 两路径审批语义待统一。

## 消息投递 / Message Delivery

飞书消息投递进 claude TUI 有两条容易踩的坑，已处理：

**1. 多行消息：文本与回车分两次写**

把 `文本 + \r` 合成**一次**写入，会被 claude TUI 判定为**粘贴**——粘贴语义是插入字面文本，结尾的 `\r` 一并成为内容而**不触发提交**，消息就停在输入框里，得人工回车。

所以 `PTYManager.send()` 对含换行的文本分两段写：先写文本（不含 `\r`），80ms 后**单独**写一次 `\r`（单独一次写在字节层等同于用户按 Enter）。单行消息保持原样一次写入，行为不变。

> 终端里手动粘贴走的是终端自己的 bracketed paste（`ESC[200~ … ESC[201~`），桥接层**原样透传不动**——剥掉标记会让粘贴内容里的换行全部变成有效提交，一次性执行一串垃圾命令。

**2. 启动期消息：等 TUI 就绪再投递**

bot 刚启动、`claude -c` 还在恢复会话时，TUI 尚未就绪，此时写入的 `\r` 会被初始化流程吞掉。

`ReadyGate` 在 `❯` 出现前挡住新消息投递，就绪后再写；**超时 30s fail-open 照常投递**（绝不挂住消息，超时会打 warn 日志）。门闸**只用于新消息派发**（飞书消息、`--command` 首条命令）——A2 的 AskUserQuestion 回答和 yes/no 回答**不能**过门闸，那时 claude 正停在 TUI 里、根本不显示 `❯`，会白等到超时。

**3. 计划任务轮次：prompt_id 轮次识别**

会话内 cron 计划任务（CronCreate 那类）触发的轮次**不经任何输入路径**，历史上轮次状态无人复位，导致其输出在飞书上不可见（规律：只有紧跟用户交互后的第一轮可见，连续第二轮起隐身）。

修复：hook 载荷携带逐轮变化的 `prompt_id`，`RoundState` 用它从输出侧识别"无人发起的新轮次"（无轮次进行中 + id 变化）→ 走统一入口 `beginRound()` 复位状态并发思考卡 → 该轮的 🟢 定稿 / 📢 通知恢复可见。`claudeBusy` 是轮次进行中的唯一事实源；`SubagentStop` 不参与识别（可能在轮末数分钟后迟到）。旧版 CLI hook 不带 `prompt_id` 时行为退回现状。

## 架构 / Architecture

```
# bridge 模式（单实例全功能）
飞书(多群+私聊) ←WSClient→ FeishuBridge ←PTY/SDK→ Claude Code
终端 Terminal ←stdin/stdout→ FeishuBridge
Web Browser ←WebSocket→ WebServer ←→ FeishuBridge

Claude Code Hooks (Stop/Notification/PostToolUse/PostToolUseFailure/SubagentStop/SessionStart)
  └── curl POST /api/hook → WebServer → FeishuBridge → 飞书
Claude Code PermissionRequest hook (http 同步)
  └── POST /api/hook/approval → ApprovalGate → 普通工具 allow / AskUserQuestion 转发飞书卡片（见「权限审批 A2」）

# 多咪架构（Docker web-server hub + 各 sbot 连接）
Docker web-server (:5554, 仅 Web UI + Hook API，含 /api/hook/approval 端点)
  ├── /ws/bot ← sbot (Code咪) --web-host  — PTY + 飞书 + SDK
  └── /ws/bot ← sbot (其他咪) --web-host  — PTY + 飞书
```

## 飞书权限 / Feishu Permissions

| 权限 | 说明 |
|------|------|
| `im:message` | 接收私聊消息 |
| `im:message.group_at_msg` | 接收群聊中 @机器人 的消息 |
| `im:message.group_msg` | 接收群聊中所有消息 |

## 多 Bot 配置 / Multi-Bot

`~/.shrimpbot/bots.json`：

```json
[
  {"name": "小虾虾", "appId": "cli_xxx", "appSecret": "secret1"},
  {"name": "键盘咪", "appId": "cli_yyy", "appSecret": "secret2"}
]
```

`sbot init` 选择要用的那只咪，写入 `~/.shrimpbot/config.json`。

## systemd 服务

```bash
# 独立 Web 服务（只跑 Web UI + Hook API，不启动 PTY/飞书）
sudo cp contrib/sbot-web.service /etc/systemd/system/
sudo systemctl enable --now sbot-web

# 手动 sbot 时自动连上去（三端同步）
sbot
```

## Docker 部署（WebServer hub）

生产推荐：Docker 跑 `--web-server` 模式当 hub，各 sbot 实例 `--web-host` 连接（多咪架构）。

```bash
# 本机构建镜像（无外网的生产机需本机 build 后传）
npm run build                              # 先编译 dist
docker build -t shrimpbot:v1.4.0 .
docker save shrimpbot:v1.4.0 | gzip | ssh user@prod 'gunzip | docker load'

# 生产机启动（docker-compose.yml 见仓库根目录）
docker compose up -d
```

`docker-compose.yml` 关键点：
- `CMD node dist/index.js --web-server`（hub 模式，不启动 PTY/飞书）
- `YZ_LOGIN_URL` / `YZ_LOGIN_APP_ID`（Web SSO）
- 挂载 `~/.shrimpbot`（users.json/settings.json）
- **不需** claude CLI / 飞书凭证 / SDK_EVENT_MODE（hub 不启动 PTY）

各 sbot 实例连接 hub：
```bash
sbot --web-host 192.168.0.18:5554   # 本机/其他机跑 bridge，连 Docker hub
```

## 日志 / Logs

```
~/.shrimpbot/logs/shrimpbot-YYYY-MM-DD.log
```

```bash
sbot --debug        # 或
LOG_LEVEL=debug sbot
```

## 开发 / Development

```bash
npm run build       # 编译 + 全局 link
npm run dev         # 编译并启动
npm test            # 运行测试
```

## Windows 安装

> **前提**：已安装 [Node.js](https://nodejs.org/) 20+（推荐 22 LTS）、[Git](https://git-scm.com/)、[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 1. 克隆并安装

```powershell
git clone https://github.com/grigs28/ShrimpBot.git $HOME\ShrimpBot
cd $HOME\ShrimpBot

# node-pty 可能没有 Windows 预编译包，跳过后重试
npm install --ignore-scripts
npm rebuild node-pty
```

如果 `node-pty` rebuild 失败（缺少 Visual Studio Build Tools），可以跳过：
```powershell
npm install --ignore-scripts
```
核心功能（飞书通信）不受影响，但终端透传模式（PTY）不可用。

### 2. 构建

```powershell
npx tsc
```

> `npm run build` 包含 `npm link`，Windows 上可能需要管理员权限。直接用 `npx tsc` 编译即可。

### 3. 安装启动脚本

将 `contrib/` 下的启动脚本复制到 PATH 目录：

```powershell
# 创建 bin 目录
mkdir -Force $HOME\.local\bin

# 复制脚本（PowerShell 用 .ps1，CMD 用 .cmd）
Copy-Item contrib\sbot.ps1 $HOME\.local\bin\sbot.ps1
Copy-Item contrib\sbot.cmd $HOME\.local\bin\sbot.cmd

# 添加到 PATH（永久生效）
[Environment]::SetEnvironmentVariable(
    'Path',
    [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin",
    'User'
)

# 重新打开终端后验证
Get-Command sbot
```

### 4. 启动

```powershell
# cd 到项目目录（.sbot 所在目录）
cd C:\Users\你\projects\my-project
sbot
```

### 5. 配置

```powershell
# 交互式向导（首次启动自动进入）
sbot init
```

或直接指定参数：
```powershell
sbot init --app-id cli_xxx --app-secret yyy --name "小虾虾"
```

项目目录下创建 `.sbot` 文件：
```
FEISHU_MODE=bridge
```

### 远程 WebServer（可选）

如果 WebServer 跑在另一台机器上：

```powershell
# 命令行
sbot --web-host 192.168.0.19:5554

# 或写在 .sbot 文件
# WEBSERVER_HOST=192.168.0.19:5554
```

### 常见问题

**Q: `npm install` 报 node-pty 错误**

`node-pty` 缺少 Windows 预编译包。使用 `npm install --ignore-scripts` 跳过。

**Q: `npm run build` 失败（`. `不是内部或外部命令）**

直接用 `npx tsc` 编译，跳过 `npm link`。然后用 `contrib/` 下的启动脚本。

**Q: `sbot` 命令找不到**

确认 `$HOME\.local\bin` 在 PATH 中，且 `sbot.ps1` / `sbot.cmd` 已复制到该目录。重新打开终端后生效。

**Q: 飞书 Bot 收不到消息**

1. 确认飞书开放平台已启用「长连接」模式
2. 确认已添加事件 `im.message.receive_v1`
3. 确认应用已「创建版本」并「发布」

## License

MIT
