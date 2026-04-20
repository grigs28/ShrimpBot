# ShrimpBot

飞书 <-> Claude Code 实时通信桥。通过 PTY 启动 Claude Code，实现飞书和终端双向同步交互。

## 快速开始

```bash
npm install && npm run build

# 配置（首次启动会自动引导，或手动创建 .env）
sbot
```

## 配置

项目根目录创建 `.env`：

```bash
FEISHU_MODE=bridge
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=your_secret
FEISHU_CHAT_IDS=oc_xxx,oc_xxx
FEISHU_ALLOWED_USERS=ou_xxx
CLAUDE_CWD=/path/to/project
```

- `FEISHU_CHAT_IDS` 留空 = 接受所有会话
- `FEISHU_ALLOWED_USERS` 留空 = 不限制用户

## 启动方式

| 命令 | 说明 |
|------|------|
| `sbot` | 全局命令，任意目录启动 |
| `npm start` | 项目目录内启动 |

## 双端交互

终端和飞书可同时操作，互不干扰：

- **终端**：直接显示 Claude Code 完整界面（透传模式），键盘直接操作
- **飞书**：实时收发消息，选项选择、yes/no 确认都支持

### 选项选择

Claude 提出选项时，飞书显示编号列表，回复编号即可选择。终端侧直接在 Claude Code 中选择。

### 自动确认

Claude 提出的 yes/no 问题默认自动通过，但危险操作（`rm -rf`、`drop table` 等）会阻止自动通过，需要手动确认。

## 架构

```
飞书 ←WSClient→ FeishuBridge ←PTY→ Claude Code
终端 ←stdin/stdout→ FeishuBridge ←PTY→ Claude Code
```

- **PTY**：通过 node-pty 启动 Claude Code CLI（`--dangerously-skip-permissions`）
- **OutputParser**：解析 Claude Code TUI 输出，提取回复文本和选项
- **WSClient**：飞书 WebSocket 长连接，实时接收消息
- **透传模式**：前台运行时自动启用，PTY 输出直接显示到终端

## 多 Bot 配置

统一配置文件 `~/.shrimpbot/bots.json`：

```json
[
  {"name": "小虾虾", "appId": "cli_xxx", "appSecret": "secret1"},
  {"name": "大虾虾", "appId": "cli_yyy", "appSecret": "secret2"}
]
```

## 日志

日志文件位于 `~/.shrimpbot/logs/shrimpbot-YYYY-MM-DD.log`

```bash
# 开启调试日志
LOG_LEVEL=debug sbot
```

## 开发

```bash
npm run build    # 编译
npm run dev      # 编译并启动
npm test         # 运行测试
```
