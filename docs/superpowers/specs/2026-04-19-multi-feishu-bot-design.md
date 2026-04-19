# ShrimpBot 多飞书机器人架构设计

## 概述

支持多个独立的飞书机器人，每个机器人服务于不同项目/团队。机器人之间进程隔离。

## 架构

```
┌─────────────────────────────────────────┐
│            ~/.claude/.mcp.json          │
│  { bots: [{name, appId, appSecret,      │
│            chatIds}] }                   │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│         Master Process (Node)            │
│  - 读取配置                              │
│  - chat_id → bot 路由                   │
│  - 进程管理 (spawn/kill)                │
└─────────────────┬───────────────────────┘
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
┌─────────┐   ┌─────────┐   ┌─────────┐
│ Bot 1  │   │ Bot 2  │   │ Bot N  │
│进程     │   │进程     │   │进程     │
└─────────┘   └─────────┘   └─────────┘
```

## 配置格式

```json
{
  "bots": [
    {
      "name": "小虾虾",
      "appId": "cli_a9474d2ef5781bce",
      "appSecret": "9B0ATvRNCn9wguH3HrjkXbYlLOTm6MKy",
      "chatIds": ["oc_248b4d3d66e287eabb96f9a76cf54daa"]
    },
    {
      "name": "项目B助手",
      "appId": "cli_another",
      "appSecret": "another_secret",
      "chatIds": ["oc_project_b_chat"]
    }
  ]
}
```

## 组件设计

### Master Process

职责：
- 读取和解析 `bots` 配置
- 为每个 Bot 启动独立子进程
- 监听消息路由（通过各 Bot 的 MCP 协议）
- 管理 Bot 进程生命周期（启动、重启、停止）

### Bot Process

每个 Bot 进程是独立的 MCP Server：
- 独立的飞书 SDK 实例
- 独立的会话管理
- 只处理其 `chatIds` 列表中的会话

### 消息路由

当飞书消息到达时：
1. Master 接收消息
2. 根据 `chat_id` 查找对应 Bot
3. 将消息转发到对应 Bot 进程
4. Bot 处理后通过 MCP 响应

## 数据流

```
飞书 → Webhook → Master → [chat_id 路由] → Bot Process → MCP → Claude Code
                                                    ↓
飞书 ← Webhook ← Master ← [响应] ← Bot Process ← MCP ← Claude Code
```

## 错误处理

- Bot 进程崩溃：Master 自动重启
- 网络错误：重试机制
- 配置错误：启动时校验并报错

## 安全考虑

- 每个 Bot 的凭据完全隔离
- 进程间通过 IPC 通信，不暴露敏感数据
- chatIds 白名单验证

## 实现步骤

1. 重构配置格式支持多 Bot
2. 实现 Master 进程
3. 实现 Bot 进程（复用现有 MCP Server）
4. 实现消息路由
5. 添加进程管理
6. 测试验证
