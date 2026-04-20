# ShrimpBot / 🦐

飞书 ↔ Claude Code 实时通信桥。通过 PTY 启动 Claude Code，实现飞书和终端双向同步交互。

A Feishu ↔ Claude Code real-time communication bridge. Launches Claude Code via PTY, enabling bidirectional sync between Feishu and terminal.

## 快速开始 / Quick Start

```bash
npm install && npm run build
sbot
```

首次启动自动引导配置。如需手动配置，在项目根目录创建 `.env`：

First launch auto-starts a setup wizard. Or manually create `.env` in project root:

```bash
FEISHU_MODE=bridge
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=your_secret
FEISHU_CHAT_IDS=oc_xxx,oc_xxx
FEISHU_ALLOWED_USERS=ou_xxx
CLAUDE_CWD=/path/to/project
```

| 变量 Variable | 说明 Description | 默认 Default |
|------|------|------|
| `FEISHU_CHAT_IDS` | 飞书会话 ID，逗号分隔 | 空 = 全部会话 |
| `FEISHU_ALLOWED_USERS` | 允许的用户 ID | 空 = 不限制 |
| `CLAUDE_CWD` | Claude Code 工作目录 | 当前目录 |

## CLI 参数 / CLI Options

```
sbot [选项 / options]

  -c, --command <text>     启动后自动执行的命令 / command to run after startup
  --cwd <dir>              工作目录 / working directory
  --chat <chat_id>         飞书会话 ID / Feishu chat ID
  --debug                  调试模式 / debug mode
  -m, --model <model>      指定模型 / specify model
  --resume                 恢复会话 / resume previous session
  --allowedTools <tools>   限制工具 / restrict tools (comma-separated)
  --max-turns <n>          最大轮次 / max conversation turns
  -h, --help               帮助 / help
```

**示例 / Examples:**

```bash
sbot                              # 交互模式 / interactive mode
sbot -c "列出文件"                 # 自动执行 / auto-run command
sbot --cwd /my/project            # 指定目录 / specify directory
sbot --debug                      # 调试 / debug mode
```

## 双端交互 / Dual-Side Interaction

终端和飞书可**同时操作**，互不干扰：

Terminal and Feishu can operate **simultaneously** without interference:

| 端 Side | 能力 Capability |
|---------|----------------|
| **终端 Terminal** | 完整 Claude Code TUI 界面（透传模式），键盘直接操作 |
| **飞书 Feishu** | 实时收发消息，选项选择、yes/no 确认 |

### 选项选择 / Option Selection

Claude 提出编号选项时，两端都能选择：
- **终端**：直接在 Claude Code 中输入
- **飞书**：回复编号即可

### 自动确认 / Auto Approve

yes/no 问题默认自动通过，但危险操作（`rm -rf`、`drop table` 等）需手动确认。

Yes/no questions are auto-approved by default, but dangerous operations require manual confirmation.

### 退出 / Exit

| 方式 Method | 说明 Description |
|-------------|-----------------|
| `/exit` in Claude | Claude 退出 → PTY 退出 → Bridge 自动退出 |
| `Ctrl+C` | 直接退出 / exit immediately |
| `Ctrl+D` | 直接退出 / exit immediately |

## 架构 / Architecture

```
飞书 Feishu ←WSClient→ FeishuBridge ←PTY→ Claude Code
终端 Terminal ←stdin/stdout→ FeishuBridge ←PTY→ Claude Code
```

| 组件 Component | 说明 Description |
|----------------|-----------------|
| **PTY** | node-pty 启动 Claude Code（`--dangerously-skip-permissions`） |
| **OutputParser** | 解析 TUI 输出，提取回复和选项 |
| **WSClient** | 飞书 WebSocket 长连接，实时收消息 |
| **透传 Passthrough** | 前台运行时 TUI 直接显示到终端 |

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
sbot --debug        # 或 / or
LOG_LEVEL=debug sbot
```

## 开发 / Development

```bash
npm run build       # 编译 + 全局 link / build & global link
npm run dev         # 编译并启动 / build & start
npm test            # 运行测试 / run tests
```

## License

MIT
