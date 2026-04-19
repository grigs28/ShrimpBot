# Multi-Feishu-Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现多飞书机器人支持，每个机器人独立进程，chat_id 路由

**Architecture:** Master 进程管理多个独立 Bot 子进程，每个 Bot 是 MCP Server。根据 chat_id 路由消息到对应 Bot 处理。

**Tech Stack:** Node.js, @modelcontextprotocol/sdk, @larksuiteoapi/node-sdk

---

## 文件结构

```
src/
├── master.ts           # Master 进程：配置加载、路由、进程管理
├── bot.ts              # Bot 进程：单个机器人 MCP Server
├── config.ts           # 配置解析
├── router.ts           # chat_id → bot 路由
├── types/index.ts      # 类型定义
└── services/
    └── feishu.ts       # 飞书服务（复用）
```

---

### Task 1: 配置格式重构

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/config.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 更新类型定义**

```typescript
// src/types/index.ts

export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  chatIds: string[];
}

export interface MultiBotConfig {
  bots: BotConfig[];
}

export interface Config {
  feishuAppId: string;
  feishuAppSecret: string;
  botName: string;
  chatIds: string[];
  isMaster: boolean;
  masterPort: number;
}
```

- [ ] **Step 2: 创建配置解析**

```typescript
// src/config.ts

import type { MultiBotConfig, BotConfig } from './types/index.js';

export function loadMultiBotConfig(): MultiBotConfig {
  // 从环境变量或配置文件读取
  const botsJson = process.env.FEISHU_BOTS || '[]';
  try {
    return JSON.parse(botsJson);
  } catch {
    throw new Error('Invalid FEISHU_BOTS JSON');
  }
}

export function loadSingleBotConfig(): BotConfig {
  return {
    name: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
  };
}
```

- [ ] **Step 3: 更新 index.ts 启动逻辑**

```typescript
// src/index.ts

import { loadMultiBotConfig, loadSingleBotConfig } from './config.js';
import { Master } from './master.js';
import { startBot } from './bot.js';

async function main() {
  if (process.env.FEISHU_MODE === 'master') {
    const config = loadMultiBotConfig();
    const master = new Master(config);
    await master.start();
  } else {
    const config = loadSingleBotConfig();
    await startBot(config);
  }
}
```

- [ ] **Step 4: 提交**

```bash
git add src/types/index.ts src/config.ts src/index.ts
git commit -m "refactor: support multi-bot configuration format"
```

---

### Task 2: Master 进程

**Files:**
- Create: `src/master.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 创建 Master 进程**

```typescript
// src/master.ts

import type { MultiBotConfig, BotConfig } from './types/index.js';
import { spawn, ChildProcess } from 'child_process';

export class Master {
  private botProcesses: Map<string, ChildProcess> = new Map();
  private chatIdToBot: Map<string, string> = new Map();

  constructor(private config: MultiBotConfig) {
    // 构建 chat_id → bot 映射
    for (const bot of config.bots) {
      for (const chatId of bot.chatIds) {
        this.chatIdToBot.set(chatId, bot.name);
      }
    }
  }

  async start(): Promise<void> {
    // 启动每个 Bot 子进程
    for (const bot of this.config.bots) {
      this.startBotProcess(bot);
    }
    console.error('Master started with', this.config.bots.length, 'bots');
  }

  private startBotProcess(bot: BotConfig): void {
    const child = spawn('node', ['dist/bot.js'], {
      env: {
        ...process.env,
        FEISHU_BOT_NAME: bot.name,
        FEISHU_APP_ID: bot.appId,
        FEISHU_APP_SECRET: bot.appSecret,
        FEISHU_CHAT_IDS: bot.chatIds.join(','),
        FEISHU_MODE: 'bot',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    child.on('exit', (code) => {
      console.error(`Bot ${bot.name} exited with code ${code}, restarting...`);
      setTimeout(() => this.startBotProcess(bot), 1000);
    });

    this.botProcesses.set(bot.name, child);
  }

  routeByChatId(chatId: string): string | undefined {
    return this.chatIdToBot.get(chatId);
  }

  stop(): void {
    for (const [name, proc] of this.botProcesses) {
      proc.kill();
      console.error(`Stopped bot: ${name}`);
    }
  }
}
```

- [ ] **Step 2: 更新 index.ts**

```typescript
// src/index.ts

async function main() {
  const mode = process.env.FEISHU_MODE || 'single';

  if (mode === 'master') {
    const config = loadMultiBotConfig();
    const master = new Master(config);
    await master.start();
    process.on('SIGINT', () => master.stop());
  } else {
    const config = loadSingleBotConfig();
    await startBot(config);
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/master.ts src/index.ts
git commit -m "feat: add Master process for multi-bot management"
```

---

### Task 3: Bot 进程

**Files:**
- Create: `src/bot.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 创建 Bot 进程入口**

```typescript
// src/bot.ts

import { MCPServer } from './server.js';
import type { BotConfig } from './types/index.js';

export async function startBot(config: BotConfig): Promise<void> {
  const server = new MCPServer({
    feishuAppId: config.appId,
    feishuAppSecret: config.appSecret,
    botName: config.name,
    chatIds: config.chatIds,
    webhookPort: 8080,
    debug: process.env.DEBUG === 'true',
  });

  console.error(`Bot ${config.name} starting for chatIds: ${config.chatIds.join(', ')}`);
  await server.start();
}
```

- [ ] **Step 2: 更新 server.ts 支持 chatIds**

```typescript
// src/server.ts

export class MCPServer {
  constructor(private config: Config) {
    // ... 现有代码 ...
  }

  // 新增：获取该 Bot 负责的 chatIds
  getChatIds(): string[] {
    return this.config.chatIds;
  }

  // 新增：检查是否处理该 chat_id
  handlesChatId(chatId: string): boolean {
    if (this.config.chatIds.length === 0) return true; // 无配置则处理所有
    return this.config.chatIds.includes(chatId);
  }
}
```

- [ ] **Step 3: 更新 types/index.ts Config**

```typescript
// src/types/index.ts Config 添加
chatIds: string[];
```

- [ ] **Step 4: 编译并测试**

```bash
npm run build
```

- [ ] **Step 5: 提交**

```bash
git add src/bot.ts src/server.ts src/types/index.ts
git commit -m "feat: add Bot process for single Feishu bot instance"
```

---

### Task 4: 消息路由（Master 到 Bot）

**Files:**
- Modify: `src/master.ts`
- Modify: `src/bot.ts`

- [ ] **Step 1: 实现 Master 路由 HTTP 服务器**

```typescript
// src/master.ts 新增

import http from 'http';

export class Master {
  private routerServer: http.Server;

  // 在 start() 中添加
  private startRouterServer(): void {
    this.routerServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/route') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { chat_id, content } = JSON.parse(body);
            const botName = this.routeByChatId(chat_id);
            if (!botName) {
              res.writeHead(404);
              res.end('Bot not found for chat_id');
              return;
            }
            const bot = this.botProcesses.get(botName);
            if (!bot || !bot.stdin) {
              res.writeHead(500);
              res.end('Bot process not available');
              return;
            }
            // 发送到对应 Bot
            bot.stdin.write(JSON.stringify({ chat_id, content }) + '\n');
            res.writeHead(200);
            res.end('OK');
          } catch (err) {
            res.writeHead(500);
            res.end('Error');
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.routerServer.listen(9090, () => {
      console.error('Router server listening on port 9090');
    });
  }
}
```

- [ ] **Step 2: Bot 进程监听 stdin 消息**

```typescript
// src/bot.ts 修改 startBot

process.stdin.on('data', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    // 处理消息
    server.handleIncomingMessage(msg);
  } catch (err) {
    console.error('Failed to parse incoming message:', err);
  }
});
```

- [ ] **Step 3: 提交**

```bash
git add src/master.ts src/bot.ts
git commit -m "feat: implement message routing from Master to Bot"
```

---

### Task 5: 测试验证

**Files:**
- Create: `tests/master.test.ts`
- Create: `tests/bot.test.ts`

- [ ] **Step 1: 写 Master 测试**

```typescript
// tests/master.test.ts

import { describe, it, expect } from 'vitest';
import { Master } from '../src/master.js';
import type { MultiBotConfig } from '../src/types/index.js';

describe('Master', () => {
  it('routes chat_id to correct bot', () => {
    const config: MultiBotConfig = {
      bots: [
        { name: 'bot1', appId: 'a', appSecret: 'b', chatIds: ['chat1', 'chat2'] },
        { name: 'bot2', appId: 'c', appSecret: 'd', chatIds: ['chat3'] },
      ],
    };
    const master = new Master(config);
    expect(master.routeByChatId('chat1')).toBe('bot1');
    expect(master.routeByChatId('chat3')).toBe('bot2');
    expect(master.routeByChatId('unknown')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 写 Bot 测试**

```typescript
// tests/bot.test.ts

import { describe, it, expect } from 'vitest';
import { MCPServer } from '../src/server.js';

describe('Bot', () => {
  it('handles configured chatIds', () => {
    const server = new MCPServer({
      feishuAppId: 'test',
      feishuAppSecret: 'test',
      botName: 'test',
      chatIds: ['chat1', 'chat2'],
      webhookPort: 8080,
      debug: false,
    });
    expect(server.handlesChatId('chat1')).toBe(true);
    expect(server.handlesChatId('chat3')).toBe(false);
  });

  it('handles all chatIds when empty', () => {
    const server = new MCPServer({
      feishuAppId: 'test',
      feishuAppSecret: 'test',
      botName: 'test',
      chatIds: [],
      webhookPort: 8080,
      debug: false,
    });
    expect(server.handlesChatId('any')).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run
```

- [ ] **Step 4: 提交**

```bash
git add tests/
git commit -m "test: add tests for Master routing and Bot chatIds"
```

---

### Task 6: 集成测试

- [ ] **Step 1: 更新 .mcp.json 为多 Bot 格式**

```json
{
  "bots": [
    {
      "name": "小虾虾",
      "appId": "cli_a9474d2ef5781bce",
      "appSecret": "9B0ATvRNCn9wguH3HrjkXbYlLOTm6MKy",
      "chatIds": ["oc_248b4d3d66e287eabb96f9a76cf54daa"]
    }
  ]
}
```

- [ ] **Step 2: 手动测试完整流程**

```bash
# 启动 Master
FEISHU_MODE=master FEISHU_BOTS='[{"name":"test","appId":"...","appSecret":"...","chatIds":["oc_xxx"]}]' npm start

# 在飞书发送消息到对应群
# 验证消息被正确 Bot 处理
```

- [ ] **Step 3: 提交配置示例**

```bash
git add .mcp.json.example
git commit -m "docs: add multi-bot .mcp.json example"
```

---

## 自检清单

- [ ] 所有 task 完成
- [ ] 所有测试通过
- [ ] 文档更新
- [ ] 无 placeholder/TODO
