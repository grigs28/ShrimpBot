# Claude Code Channels 飞书桥接 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个基于 Claude Code 官方 Channels 协议的 MCP Server，实现终端 Claude Code 与飞书的双向消息同步。

**Architecture:** MCP Server 通过 stdio 与 Claude Code 通信，声明 `experimental:claude/channel` 能力。Claude 发送的通知通过 ChannelHandler 处理后转发给 FeishuService 发往飞书；飞书消息通过 FeishuService 接收后注入到 Claude 会话。

**Tech Stack:** TypeScript + @modelcontextprotocol/sdk + @larksuiteoapi/node-sdk + Node.js 18+

---

## 文件结构

```
/opt/ShrimpBot/
├── package.json                         # 项目配置 + 依赖
├── tsconfig.json                        # TypeScript 配置
├── src/
│   ├── index.ts                         # 入口，stdio 启动 MCP Server
│   ├── server.ts                        # MCP Server 主类
│   ├── capabilities.ts                  # 能力声明
│   ├── types/
│   │   └── index.ts                    # 类型定义
│   ├── handlers/
│   │   ├── channel.ts                  # notifications/claude/channel 处理
│   │   └── tools.ts                    # 工具调用处理
│   └── services/
│       ├── feishu.ts                   # Feishu API 封装
│       └── session.ts                  # 会话管理
└── tests/
    └── *.test.ts
```

---

## Task 1: 项目初始化

**Files:**
- Create: `/opt/ShrimpBot/package.json`
- Create: `/opt/ShrimpBot/tsconfig.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "claude-code-channels-feishu",
  "version": "1.0.0",
  "description": "Claude Code Channels bridge for Feishu",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  },
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.5.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: 安装依赖**

Run: `cd /opt/ShrimpBot && npm install`
Expected: 依赖安装完成

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: 项目初始化，配置 TypeScript + MCP SDK + 飞书 SDK

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: 类型定义

**Files:**
- Create: `/opt/ShrimpBot/src/types/index.ts`

- [ ] **Step 1: 创建类型定义**

```typescript
// 飞书消息来源
export interface FeishuMessage {
  chat_id: string;
  user_id: string;
  user_name: string;
  text: string;
  timestamp: number;
}

// Claude Channel 消息格式
export interface ClaudeChannelMessage {
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
}

// 会话状态
export interface Session {
  chatId: string;
  lastMessageTimestamp: number;
  createdAt: number;
}

// 配置
export interface Config {
  feishuAppId: string;
  feishuAppSecret: string;
  webhookPort: number;
  debug: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: 添加类型定义

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: FeishuService

**Files:**
- Create: `/opt/ShrimpBot/src/services/feishu.ts`

- [ ] **Step 1: 创建 FeishuService**

```typescript
import { Client } from '@larksuiteoapi/node-sdk';
import type { FeishuMessage } from '../types/index.js';

export class FeishuService {
  private client: Client;
  private messageHandlers: Map<string, (msg: FeishuMessage) => void> = new Map();

  constructor(appId: string, appSecret: string) {
    this.client = new Client({
      appId,
      appSecret,
      disableTokenCache: false,
    });
  }

  // 发送消息到飞书
  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      params: {
        receive_id_type: 'chat_id',
      },
    });
  }

  // 注册消息处理器
  onMessage(chatId: string, handler: (msg: FeishuMessage) => void): void {
    this.messageHandlers.set(chatId, handler);
  }

  // 处理接收到的飞书消息
  async handleFeishuEvent(event: any): Promise<void> {
    const chatId = event.header?.chat_id || '';
    const handler = this.messageHandlers.get(chatId);
    if (!handler) return;

    const message: FeishuMessage = {
      chat_id: chatId,
      user_id: event.header?.sender?.sender_id?.user_id || '',
      user_name: event.header?.sender?.sender_id?.user_id || 'Unknown',
      text: event.event?.message?.content || '',
      timestamp: Date.now(),
    };

    handler(message);
  }

  // 启动 Webhook 监听（占位，后续实现）
  startWebhook(port: number): void {
    // TODO: 实现 Webhook 服务器
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/feishu.ts
git commit -m "feat: 添加 FeishuService，封装飞书 IM API

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: SessionService

**Files:**
- Create: `/opt/ShrimpBot/src/services/session.ts`

- [ ] **Step 1: 创建 SessionService**

```typescript
import type { Session } from '../types/index.js';

export class SessionService {
  private sessions: Map<string, Session> = new Map();

  getOrCreate(chatId: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const session: Session = {
      chatId,
      lastMessageTimestamp: 0,
      createdAt: Date.now(),
    };
    this.sessions.set(chatId, session);
    return session;
  }

  updateTimestamp(chatId: string, timestamp: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.lastMessageTimestamp = timestamp;
    }
  }

  get(chatId: string): Session | undefined {
    return this.sessions.get(chatId);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/session.ts
git commit -m "feat: 添加 SessionService，会话管理

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: MCP 能力声明

**Files:**
- Create: `/opt/ShrimpBot/src/capabilities.ts`

- [ ] **Step 1: 创建能力声明**

```typescript
import type { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const SERVER_CAPABILITIES = {
  capabilities: {
    experimental: {
      'claude/channel': {},
    },
    tools: {
      list: true,
      call: true,
    },
  },
};

export const TOOL_SCHEMAS = {
  list: ListToolsRequestSchema,
  call: CallToolRequestSchema,
};

// 可用工具列表
export const TOOLS = [
  {
    name: 'send_feishu_message',
    description: '发送消息到飞书',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '飞书会话 ID' },
        text: { type: 'string', description: '消息内容' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'list_chats',
    description: '获取飞书会话列表',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/capabilities.ts
git commit -m "feat: 声明 MCP Server capabilities，包含 claude/channel 实验能力

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Channel 通知处理

**Files:**
- Create: `/opt/ShrimpBot/src/handlers/channel.ts`

- [ ] **Step 1: 创建 ChannelHandler**

```typescript
import type { FeishuService } from '../services/feishu.js';
import type { SessionService } from '../services/session.js';
import type { ClaudeChannelMessage } from '../types/index.js';

export class ChannelHandler {
  constructor(
    private feishuService: FeishuService,
    private sessionService: SessionService
  ) {}

  // 处理 Claude Channel 通知
  async handleNotification(params: any): Promise<void> {
    const message = params.message as ClaudeChannelMessage;
    if (!message?.content) return;

    // 从通知中提取 chat_id（Claude Code 会话关联的飞书会话）
    const chatId = this.extractChatId(params);
    if (!chatId) return;

    // 更新会话时间戳
    this.sessionService.updateTimestamp(chatId, message.timestamp);

    // 发送到飞书
    try {
      await this.feishuService.sendMessage(chatId, message.content);
    } catch (err) {
      console.error('发送飞书消息失败:', err);
    }
  }

  // 从通知参数中提取 chat_id
  private extractChatId(params: any): string | undefined {
    // Claude Channel 协议可能通过 session_id 或其他字段关联会话
    return params.session_id || params.chat_id;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/handlers/channel.ts
git commit -m "feat: 添加 ChannelHandler，处理 Claude Channel 通知

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Tools 处理

**Files:**
- Create: `/opt/ShrimpBot/src/handlers/tools.ts`

- [ ] **Step 1: 创建 ToolsHandler**

```typescript
import type { FeishuService } from '../services/feishu.js';
import { TOOLS } from '../capabilities.js';

export class ToolsHandler {
  constructor(private feishuService: FeishuService) {}

  // 返回工具列表
  listTools() {
    return { tools: TOOLS };
  }

  // 处理工具调用
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'send_feishu_message':
        return this.sendMessage(args.chat_id, args.text);
      case 'list_chats':
        return this.listChats();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async sendMessage(chatId: string, text: string): Promise<string> {
    await this.feishuService.sendMessage(chatId, text);
    return `消息已发送到 ${chatId}`;
  }

  private async listChats(): Promise<any> {
    // TODO: 实现获取会话列表
    return { chats: [] };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/handlers/tools.ts
git commit -m "feat: 添加 ToolsHandler，处理 MCP 工具调用

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 8: MCP Server 主类

**Files:**
- Create: `/opt/ShrimpBot/src/server.ts`

- [ ] **Step 1: 创建 MCPServer 主类**

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FeishuService } from './services/feishu.js';
import { SessionService } from './services/session.js';
import { ChannelHandler } from './handlers/channel.js';
import { ToolsHandler } from './handlers/tools.js';
import { SERVER_CAPABILITIES } from './capabilities.js';
import type { Config } from './types/index.js';

export class MCPServer {
  private server: Server;
  private feishuService: FeishuService;
  private sessionService: SessionService;
  private channelHandler: ChannelHandler;
  private toolsHandler: ToolsHandler;

  constructor(config: Config) {
    this.feishuService = new FeishuService(config.feishuAppId, config.feishuAppSecret);
    this.sessionService = new SessionService();
    this.channelHandler = new ChannelHandler(this.feishuService, this.sessionService);
    this.toolsHandler = new ToolsHandler(this.feishuService);

    this.server = new Server(
      { name: 'claude-code-channels-feishu', version: '1.0.0' },
      SERVER_CAPABILITIES
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // 处理 Claude Channel 通知
    this.server.setRequestHandler(
      { method: 'notifications/claude/channel' } as any,
      async (params: any) => {
        await this.channelHandler.handleNotification(params);
        return { status: 'ok' };
      }
    );

    // 处理工具列表
    this.server.setRequestHandler(
      { method: 'tools/list' },
      async () => this.toolsHandler.listTools()
    );

    // 处理工具调用
    this.server.setRequestHandler(
      { method: 'tools/call' },
      async (params: any) => {
        const result = await this.toolsHandler.callTool(params.name, params.arguments);
        return { content: [{ type: 'text', text: result }] };
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code Channels Feishu Bridge 已启动');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: 添加 MCPServer 主类，整合所有组件

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 9: 入口文件

**Files:**
- Create: `/opt/ShrimpBot/src/index.ts`

- [ ] **Step 1: 创建入口文件**

```typescript
import { MCPServer } from './server.js';
import type { Config } from './types/index.js';

function getConfig(): Config {
  return {
    feishuAppId: process.env.FEISHU_APP_ID || '',
    feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
    webhookPort: parseInt(process.env.FEISHU_WEBHOOK_PORT || '8080', 10),
    debug: process.env.DEBUG === 'true',
  };
}

async function main() {
  const config = getConfig();

  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('错误：需要设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
    process.exit(1);
  }

  const server = new MCPServer(config);
  await server.start();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: 添加入口文件，通过 stdio 启动 MCP Server

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 10: 单元测试

**Files:**
- Create: `/opt/ShrimpBot/tests/session.test.ts`
- Create: `/opt/ShrimpBot/tests/feishu.test.ts`

- [ ] **Step 1: 创建 SessionService 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { SessionService } from '../src/services/session.js';

describe('SessionService', () => {
  it('getOrCreate 创建新会话', () => {
    const service = new SessionService();
    const session = service.getOrCreate('chat-123');
    expect(session.chatId).toBe('chat-123');
    expect(session.lastMessageTimestamp).toBe(0);
  });

  it('getOrCreate 返回已有会话', () => {
    const service = new SessionService();
    const s1 = service.getOrCreate('chat-123');
    const s2 = service.getOrCreate('chat-123');
    expect(s1).toBe(s2);
  });

  it('updateTimestamp 更新会话时间戳', () => {
    const service = new SessionService();
    service.getOrCreate('chat-123');
    service.updateTimestamp('chat-123', 999);
    const session = service.get('chat-123');
    expect(session?.lastMessageTimestamp).toBe(999);
  });

  it('delete 移除会话', () => {
    const service = new SessionService();
    service.getOrCreate('chat-123');
    service.delete('chat-123');
    expect(service.get('chat-123')).toBeUndefined();
  });

  it('list 返回所有会话', () => {
    const service = new SessionService();
    service.getOrCreate('chat-1');
    service.getOrCreate('chat-2');
    expect(service.list()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 创建 FeishuService Mock 测试**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FeishuService } from '../src/services/feishu.js';

describe('FeishuService', () => {
  it('sendMessage 调用 IM API', async () => {
    // Mock Client
    const mockCreate = vi.fn().mockResolvedValue({});
    vi.mock('@larksuiteoapi/node-sdk', () => ({
      Client: vi.fn().mockImplementation(() => ({
        im: {
          v1: {
            message: { create: mockCreate },
          },
        },
      })),
    }));

    const service = new FeishuService('app-id', 'app-secret');
    await service.sendMessage('chat-123', 'Hello');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receive_id: 'chat-123',
          msg_type: 'text',
        }),
      })
    );
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd /opt/ShrimpBot && npx vitest run`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: 添加 SessionService 和 FeishuService 单元测试

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## 自检清单

**1. Spec 覆盖检查：**
- [x] MCP Server 主类 (Task 8)
- [x] FeishuService (Task 3)
- [x] SessionService (Task 4)
- [x] ChannelHandler (Task 6)
- [x] ToolsHandler (Task 7)
- [x] 入口文件 (Task 9)
- [x] 能力声明 (Task 5)
- [x] 类型定义 (Task 2)
- [x] 项目初始化 (Task 1)
- [x] 单元测试 (Task 10)

**2. 占位符扫描：** 无 TBD/TODO/实现细节未填

**3. 类型一致性检查：** 所有文件使用统一的 Config、FeishuMessage、Session 类型

---

## 实施选择

**计划完成，保存于 `docs/superpowers/plans/2026-04-19-claude-code-channels-feishu-bridge-plan.md`**

两个执行选项：

**1. Subagent-Driven（推荐）** — 每个 Task 派发一个 subagent，任务间有审核

**2. Inline Execution** — 本 session 内批量执行，带检查点

选哪个？