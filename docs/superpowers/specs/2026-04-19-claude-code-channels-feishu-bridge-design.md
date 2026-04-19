# Claude Code Channels 飞书桥接 设计文档

> **状态：** 已批准
> **日期：** 2026-04-19

## 1. 目标

构建一个基于 Claude Code **官方 Channels 协议**的 MCP Server，实现终端 Claude Code 与飞书聊天之间的**双向消息同步**：

- Claude Code 的回复 → 实时推送到飞书
- 飞书用户消息 → 实时注入到 Claude Code 并获得回复
- 用户可在任一方发起对话，另一方同步看到

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code                           │
│   ┌─────────────────────────────────────────────────┐   │
│   │  MCP Client (官方 channels protocol)             │   │
│   │  - capabilities: { experimental: { claude/channel: {} } } │
│   │  - 发送 notifications/claude/channel 通知        │   │
│   └──────────────┬──────────────────────────────────┘   │
│                  │ stdio + notifications/claude/channel
└──────────────────┼──────────────────────────────────────┘
                   │
┌──────────────────┼──────────────────────────────────────┐
│  MCP Server (我们的实现)                                  │
│                                                           │
│  capabilities: {                                          │
│    experimental: { 'claude/channel': {} },               │
│    tools: {}                                             │
│  }                                                       │
│                                                           │
│  ┌─────────────────────────────────────────────────┐     │
│  │ ChannelHandler                                  │     │
│  │ - 接收 Claude 通知，解析消息内容                │     │
│  │ - 路由到 FeishuService                         │     │
│  └──────────────────────┬──────────────────────────┘     │
│                          │                                │
│  ┌──────────────────────┴──────────────────────────┐     │
│  │ FeishuService                                  │     │
│  │ - 发消息到飞书 (IM API)                        │     │
│  │ - 接收飞书消息 (Webhook / Long Polling)        │     │
│  └─────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────┘
```

## 3. 技术选型

| 组件 | 技术 | 说明 |
|------|------|------|
| MCP Server | TypeScript + @modelcontextprotocol/sdk | 官方 SDK |
| 传输协议 | stdio | Claude Code 原生支持 |
| 飞书 API | @larksuiteoapi/node-sdk | 官方 SDK |
| 运行时 | Node.js 18+ | ESM |

## 4. MCP Server 能力声明

```typescript
{
  capabilities: {
    experimental: {
      'claude/channel': {}  // 核心：声明我们是 Claude Channel 桥接
    },
    tools: {}
  }
}
```

## 5. 消息格式

### 5.1 Claude → 飞书 (notifications/claude/channel)

Claude Code 通过官方协议发送的通知格式：

```typescript
{
  method: 'notifications/claude/channel',
  params: {
    message: {
      role: 'assistant' | 'user',
      content: string,
      timestamp: number
    }
  }
}
```

### 5.2 飞书 → Claude

飞书消息通过 MCP 协议定义的工具返回给 Claude：

```typescript
{
  name: 'feishu_message',
  arguments: {
    chat_id: string,
    user_name: string,
    text: string,
    timestamp: number
  }
}
```

## 6. 核心组件

### 6.1 MCPServer

- 使用 `@modelcontextprotocol/sdk` 的 `Server` 类
- 声明 `claude/channel` 实验能力
- 处理 `notifications/claude/channel` 通知
- 暴露工具：`send_message`, `list_chats`

### 6.2 FeishuService

**职责：**
- `sendMessage(chatId, text)` — 通过飞书 IM API 发消息
- `registerWebhook(chatId, callback)` — 注册消息接收
- `getChatInfo(chatId)` — 获取会话信息

**飞书 API 端点：**
- 发消息：`POST /im/v1/messages?receive_id_type=chat_id`
- 收消息：Webhook 回调 或 Long Polling

### 6.3 MessageRouter

**职责：**
- 路由 Claude 通知 → FeishuService.sendMessage
- 路由飞书消息 → 格式化 → 返回给 Claude

## 7. 会话管理

每个飞书 chat_id 对应一个 Claude Code 会话实例：

```
chat_id_1 → Claude Session A
chat_id_2 → Claude Session B
```

- MCP Server 支持多会话并发
- 每个会话独立维护 last_message_timestamp

## 8. 错误处理

| 场景 | 处理方式 |
|------|----------|
| 飞书 API 超时 | 返回 MCP 错误，重试由 Claude Code 协议层处理 |
| 消息格式错误 | 记录日志，跳过该消息 |
| Claude 连接断开 | 清理会话资源 |
| 飞书 Webhook 失效 | 自动重新注册 |

## 9. 启动流程

1. MCP Server 通过 stdio 启动
2. Claude Code 检测到 `claude/channel` 能力，建立连接
3. Server 初始化 FeishuService
4. 注册 Webhook 或启动 Long Polling
5. 双方开始消息循环

## 10. 项目结构

```
/opt/ShrimpBot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 入口，stdio 启动
│   ├── server.ts             # MCP Server 主类
│   ├── capabilities.ts       # 能力声明
│   ├── handlers/
│   │   ├── channel.ts        # notifications/claude/channel 处理
│   │   └── tools.ts          # 工具调用处理
│   ├── services/
│   │   ├── feishu.ts         # Feishu API 封装
│   │   └── session.ts        # 会话管理
│   └── types/
│       └── index.ts          # 类型定义
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-19-claude-code-channels-feishu-bridge-design.md
└── tests/
    └── *.test.ts
```

## 11. 配置项

通过环境变量或 CLI 参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--feishu-app-id` | 飞书应用 App ID | - |
| `--feishu-app-secret` | 飞书应用 App Secret | - |
| `--feishu-webhook-port` | Webhook 监听端口 | 8080 |
| `--debug` | 调试模式 | false |

## 12. 测试策略

- **单元测试**：FeishuService 消息格式化、Session 管理
- **集成测试**：Mock Claude Code MCP 客户端，验证协议正确性
- **手动测试**：在飞书发消息，验证 Claude 回复同步

## 13. 安全考虑

- 飞书 Webhook 需验证签名
- App Secret 不硬编码，通过环境变量注入
- MCP 通信仅本地 stdio，无网络暴露
