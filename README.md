# Claude Code Channels Feishu Bridge

基于 Claude Code 官方 Channels 协议的飞书桥接，实现终端 Claude Code 与飞书的双向消息同步。

## 安装

```bash
npm install
npm run build
```

## 配置

### 环境变量

```bash
export FEISHU_APP_ID=your_app_id
export FEISHU_APP_SECRET=your_app_secret
export FEISHU_WEBHOOK_PORT=8080
export FEISHU_VERIFICATION_TOKEN=your_verification_token
export FEISHU_ENCRYPT_KEY=your_encrypt_key
```

### Claude Code 配置

在 Claude Code 设置文件 `~/.claude/settings.json` 添加：

```json
{
  "mcpServers": {
    "feishu": {
      "command": "node",
      "args": ["/path/to/claude-code-channels-feishu/dist/index.js"]
    }
  }
}
```

或通过命令行启动：

```bash
claude --mcp-server feishu
```

## 使用

1. 启动 MCP Server：
```bash
FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx node dist/index.js
```

2. 在 Claude Code 中即可通过工具发送飞书消息

## 工具

- `send_feishu_message` — 发送消息到飞书
- `list_chats` — 获取飞书会话列表

Claude Code 的回复会自动同步到飞书。
