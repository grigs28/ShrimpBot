# ShrimpBot / 🦐

飞书 ↔ Claude Code 实时通信桥。通过 PTY 启动 Claude Code，实现飞书和终端双向同步交互。

支持**多群聊**和**单人私聊**同时工作，自动发现新会话并记录。

## 快速开始 / Quick Start

```bash
npm install && npm run build
sbot
```

首次启动自动引导配置。也可以用 `sbot init` 初始化：

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

## 多群和私聊 / Multi-Chat Support

ShrimpBot 支持**同时**处理多个群聊和单人私聊：

- **自动发现**：新的群聊或私聊消息到来时，自动记录到 `~/.shrimpbot/config.json`
- **消息队列**：Claude 正在回复时，其他会话的消息自动排队，回复完成后按序处理
- **精确路由**：每个回复都会发送到发起提问的会话，不会串聊
- **排队通知**：排队时飞书会提示 `⏳ 排队中`

### 工作流程

```
群聊A 用户发消息 → Claude 回复 → 回复发到群聊A
         ↓ (同时)
私聊B 用户发消息 → 排队等待 → Claude 回复完A后处理 → 回复发到私聊B
```

### 权限配置

| 权限 | 说明 |
|------|------|
| `im:message` | 接收私聊消息 |
| `im:message.group_at_msg` | 接收群聊中 @机器人 的消息 |
| `im:message.group_msg` | 接收群聊中所有消息 |

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
  --clone                  飞书与终端完全同步（多行完整显示）
  -h, --help               显示帮助

init 选项:
  --app-id <id>            飞书 App ID
  --app-secret <secret>    飞书 App Secret
  --name <名称>            Bot 名称
  --chat <chat_id>         飞书会话 ID

Claude 选项（全部透传给 Claude Code CLI）:
  -m, --model              指定模型
  --resume                 恢复上次会话
  --allowedTools           限制可用工具
  --max-turns              最大对话轮次
  ... 以及 Claude Code 支持的任何参数

示例:
  sbot                                 启动交互模式
  sbot init                            交互式初始化
  sbot init --app-id cli_xxx --app-secret yyy --name "小虾虾"
  sbot --clone                         飞书完全同步模式
  sbot --web                           飞书+终端+Web 三端模式
  sbot --command "列出文件"             启动并自动执行命令
  sbot --cwd /tmp --model claude-opus  sbot 参数 + Claude 参数混用
```

## 双端交互 / Dual-Side Interaction

终端、飞书和 Web 可**同时操作**，互不干扰：

| 端 Side | 能力 Capability |
|---------|----------------|
| **终端 Terminal** | 完整 Claude Code TUI 界面（透传模式），键盘直接操作 |
| **飞书 Feishu** | 实时收发消息，选项选择、yes/no 确认，富文本 Markdown 渲染 |
| **Web** | 浏览器终端界面（`--web` 启用），端口 5554 |

### 选项选择 / Option Selection

Claude 提出编号选项时，两端都能选择：
- **终端**：直接在 Claude Code 中输入
- **飞书**：回复编号即可

### 自动确认 / Auto Approve

yes/no 问题默认自动通过，但危险操作（`rm -rf`、`drop table` 等）需手动确认。

### 退出 / Exit

| 方式 Method | 说明 Description |
|-------------|-----------------|
| `/exit` in Claude | Claude 退出 → PTY 退出 → Bridge 自动退出 |
| `Ctrl+C` | 直接退出 |
| `Ctrl+D` | 直接退出 |

## 架构 / Architecture

```
飞书(多群+私聊) ←WSClient→ FeishuBridge ←PTY→ Claude Code
终端 Terminal ←stdin/stdout→ FeishuBridge ←PTY→ Claude Code
Web Browser ←WebSocket→ WebServer ←→ FeishuBridge

Claude Code Hooks (Stop/Notification/Failure)
  └── curl POST /api/hook → WebServer → FeishuBridge → 飞书
```

| 组件 Component | 说明 Description |
|----------------|-----------------|
| **PTY** | node-pty 启动 Claude Code（`--dangerously-skip-permissions`） |
| **OutputParser** | 解析 TUI 输出，提取回复和选项 |
| **WSClient** | 飞书 WebSocket 长连接，实时收消息 |
| **WebServer** | Web 终端 + Hook API 接收端点 |
| **消息队列** | 多会话消息排队，按序处理 |
| **透传 Passthrough** | 前台运行时 TUI 直接显示到终端 |
| **Claude Hooks** | 自动配置 Stop/Notification/PostToolUseFailure 事件推送 |

### 模式说明 / Modes

| 模式 | 说明 |
|------|------|
| `--clone` | 飞书全量同步：所有完整回复都发送到飞书 |
| 默认（无 --clone） | 通知模式：任务完成、错误、选择项、危险操作等关键事件发飞书 |
| `--web` | 启用 Web 终端，无飞书配置时为纯 Web 模式 |

## 多 Bot 配置 / Multi-Bot

统一配置 `~/.shrimpbot/bots.json`：

```json
[
  {"name": "小虾虾", "appId": "cli_xxx", "appSecret": "secret1"},
  {"name": "大虾虾", "appId": "cli_yyy", "appSecret": "secret2"}
]
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

## License

MIT
