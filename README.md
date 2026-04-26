# ShrimpBot / 🦐

飞书 ↔ Claude Code 实时通信桥。通过 PTY 启动 Claude Code，实现飞书、终端、Web 三端同步交互。

支持**多群聊**和**单人私聊**同时工作，自动发现新会话并记录。

> **要求**：Claude Code ≥ v2.1.47（Stop hook 需 `last_assistant_message` 字段）

## 快速开始 / Quick Start

```bash
npm install && npm run build
sbot
```

无参数启动 = 全功能：自动检测端口、加载配置、启动三端。

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

| 模式 | 飞书消息 | 说明 |
|------|----------|------|
| **默认** | 交互式卡片 | 任务开始 → 🔵思考中，完成 → 🟢卡片更新，错误 → 🔴 |
| `--clone` | 纯文本全量 | 所有完整回复都发飞书，原样发送 |
| `--web-server` | 无 | 独立 Web 服务，供 sbot 连接 |

## Claude Hooks 集成

自动配置 Claude Code hooks 推送事件：

| Hook 事件 | 用途 |
|-----------|------|
| `Stop` | 任务完成，更新飞书卡片 |
| `Notification` | Claude 主动通知用户 |
| `PostToolUseFailure` | 工具调用出错 |

## 架构 / Architecture

```
飞书(多群+私聊) ←WSClient→ FeishuBridge ←PTY→ Claude Code
终端 Terminal ←stdin/stdout→ FeishuBridge ←PTY→ Claude Code
Web Browser ←WebSocket→ WebServer ←→ FeishuBridge

Claude Code Hooks (Stop/Notification/Failure)
  └── curl POST /api/hook → WebServer → FeishuBridge → 飞书

sbot ←WebSocket(/ws/bot)→ 独立 WebServer (systemd)
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
