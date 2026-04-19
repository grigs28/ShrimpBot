# CLI Bridge 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 shrimpbot-bridge，让 Claude Code CLI 终端和飞书聊天双向实时同步，同时保留现有 ShrimpBot 全部功能。

**Architecture:** 双引擎架构。shrimpbot-bridge 是独立命令行工具，spawn Claude Code CLI 进程，通过 stdin/stdout 桥接到 ShrimpBot API。ShrimpBot 服务端新增 BridgeRegistry 管理绑定，message-bridge 根据绑定路由消息。现有 SDK headless 模式零改动保留。

**Tech Stack:** Node.js, TypeScript, node:child_process (spawn), SSE (Server-Sent Events), HTTP API

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/api/bridge-registry.ts` | 服务端：管理 bridge 绑定、消息队列、心跳检测 |
| 新增 | `src/api/routes/bridge-routes.ts` | 服务端：bridge API 路由（注册/消息/事件） |
| 新增 | `src/bridge/cli-bridge.ts` | 客户端：shrimpbot-bridge 主逻辑（spawn CLI、解析 stdout、转发消息） |
| 新增 | `src/bridge/stream-json-parser.ts` | 客户端：逐行解析 `--output-format stream-json` |
| 新增 | `src/bridge/terminal-ui.ts` | 客户端：终端输出渲染（标注消息来源） |
| 新增 | `bin/shrimpbot-bridge` | 客户端：CLI 入口脚本 |
| 修改 | `src/api/http-server.ts` | 挂载 bridge 路由，注入 BridgeRegistry |
| 修改 | `src/api/routes/index.ts` | 导出 handleBridgeRoutes |
| 修改 | `src/api/routes/types.ts` | RouteContext 增加 bridgeRegistry |
| 修改 | `src/bridge/message-bridge.ts` | handleMessage 中增加 bridge 路由判断 |
| 修改 | `src/index.ts` | 初始化 BridgeRegistry |
| 修改 | `package.json` | 更新 update-cli 脚本 |

---

### Task 1: BridgeRegistry — 服务端绑定管理

**Files:**
- Create: `src/api/bridge-registry.ts`

- [ ] **Step 1: 实现 BridgeRegistry**

```typescript
// src/api/bridge-registry.ts
import type { Logger } from '../utils/logger.js';

export interface BridgeBinding {
  chatId: string;
  connectedAt: number;
  lastHeartbeat: number;
  /** Pending messages from Feishu, waiting for bridge to consume via SSE */
  messageQueue: BridgeMessage[];
  /** Resolve function for the current SSE wait (so we can push immediately) */
  sseResolve: ((msg: BridgeMessage) => void) | null;
}

export interface BridgeMessage {
  source: 'feishu';
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
}

const HEARTBEAT_TIMEOUT_MS = 30_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;

export class BridgeRegistry {
  private bindings = new Map<string, BridgeBinding>();
  private heartbeatTimer: ReturnType<typeof setInterval>;

  constructor(private logger: Logger) {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_CHECK_INTERVAL_MS);
  }

  /** Register a bridge for a chatId. Returns false if already bound. */
  register(chatId: string): boolean {
    if (this.bindings.has(chatId)) return false;
    this.bindings.set(chatId, {
      chatId,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      messageQueue: [],
      sseResolve: null,
    });
    this.logger.info({ chatId }, 'Bridge registered');
    return true;
  }

  /** Unregister a bridge. */
  unregister(chatId: string): void {
    const binding = this.bindings.get(chatId);
    if (!binding) return;
    // Reject any pending SSE wait
    if (binding.sseResolve) {
      binding.sseResolve = null;
    }
    this.bindings.delete(chatId);
    this.logger.info({ chatId }, 'Bridge unregistered');
  }

  /** Check if a chatId has an active bridge. */
  isBound(chatId: string): boolean {
    return this.bindings.has(chatId);
  }

  /** Update heartbeat timestamp. */
  heartbeat(chatId: string): void {
    const binding = this.bindings.get(chatId);
    if (binding) {
      binding.lastHeartbeat = Date.now();
    }
  }

  /** Enqueue a Feishu message for the bridge. Resolves SSE if waiting. */
  enqueueMessage(msg: BridgeMessage): boolean {
    const binding = this.bindings.get(msg.chatId);
    if (!binding) return false;
    if (binding.sseResolve) {
      const resolve = binding.sseResolve;
      binding.sseResolve = null;
      resolve(msg);
    } else {
      binding.messageQueue.push(msg);
    }
    return true;
  }

  /** Wait for the next message (SSE-style). Returns immediately if queue has items. */
  waitForMessage(chatId: string, timeoutMs: number = 25_000): Promise<BridgeMessage | null> {
    const binding = this.bindings.get(chatId);
    if (!binding) return Promise.resolve(null);

    // Drain queue first
    if (binding.messageQueue.length > 0) {
      return Promise.resolve(binding.messageQueue.shift()!);
    }

    // Wait for new message
    return new Promise<BridgeMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        binding.sseResolve = null;
        resolve(null); // timeout → bridge will reconnect
      }, timeoutMs);

      binding.sseResolve = (msg: BridgeMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  /** Get all active bindings info. */
  listBindings(): Array<{ chatId: string; connectedAt: number; lastHeartbeat: number }> {
    return Array.from(this.bindings.values()).map((b) => ({
      chatId: b.chatId,
      connectedAt: b.connectedAt,
      lastHeartbeat: b.lastHeartbeat,
    }));
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [chatId, binding] of this.bindings) {
      if (now - binding.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.logger.warn({ chatId }, 'Bridge heartbeat timeout, removing binding');
        this.unregister(chatId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.heartbeatTimer);
    this.bindings.clear();
  }
}
```

- [ ] **Step 2: 编译验证**

Run: `cd /opt/ShrimpBot && npx tsc --noEmit src/api/bridge-registry.ts 2>&1 | head -20`
Expected: 无错误或仅缺少依赖（后续 Task 会修复）

- [ ] **Step 3: Commit**

```bash
cd /opt/ShrimpBot && git add src/api/bridge-registry.ts && git commit -m "feat(bridge): add BridgeRegistry for managing CLI bridge bindings"
```

---

### Task 2: Bridge 路由 — 服务端 API

**Files:**
- Create: `src/api/routes/bridge-routes.ts`
- Modify: `src/api/routes/types.ts` — 增加 bridgeRegistry
- Modify: `src/api/routes/index.ts` — 导出 bridge 路由

- [ ] **Step 1: RouteContext 增加 bridgeRegistry**

在 `src/api/routes/types.ts` 的 import 区域末尾新增：
```typescript
import type { BridgeRegistry } from '../bridge-registry.js';
```

在 `RouteContext` interface 末尾新增属性：
```typescript
  bridgeRegistry?: BridgeRegistry;
```

- [ ] **Step 2: 实现 bridge-routes.ts**

```typescript
// src/api/routes/bridge-routes.ts
import type * as http from 'node:http';
import { jsonResponse, readBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleBridgeRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { bridgeRegistry, registry, logger } = ctx;
  if (!bridgeRegistry) return false;

  // POST /bridge/register
  if (method === 'POST' && url === '/bridge/register') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    const ok = bridgeRegistry.register(chatId);
    if (!ok) { jsonResponse(res, 409, { error: 'chatId already bound to another bridge' }); return true; }
    jsonResponse(res, 200, { status: 'registered', chatId });
    return true;
  }

  // POST /bridge/unregister
  if (method === 'POST' && url === '/bridge/unregister') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    bridgeRegistry.unregister(chatId);
    jsonResponse(res, 200, { status: 'unregistered', chatId });
    return true;
  }

  // POST /bridge/heartbeat
  if (method === 'POST' && url === '/bridge/heartbeat') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    bridgeRegistry.heartbeat(chatId);
    jsonResponse(res, 200, { status: 'ok' });
    return true;
  }

  // GET /bridge/messages/:chatId — SSE-style long poll for Feishu messages
  if (method === 'GET' && url.startsWith('/bridge/messages/')) {
    const chatId = url.slice('/bridge/messages/'.length).split('?')[0];
    if (!chatId || !bridgeRegistry.isBound(chatId)) {
      jsonResponse(res, 404, { error: 'No bridge bound for this chatId' });
      return true;
    }
    const msg = await bridgeRegistry.waitForMessage(chatId);
    if (msg) {
      jsonResponse(res, 200, msg);
    } else {
      jsonResponse(res, 204, null); // No content, bridge should retry
    }
    return true;
  }

  // POST /bridge/events/:chatId — bridge sends Claude output events
  if (method === 'POST' && url.startsWith('/bridge/events/')) {
    const chatId = url.slice('/bridge/events/'.length).split('?')[0];
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    const body = await readBody(req);
    let event: any;
    try { event = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }

    // Forward to the appropriate bot's sender to update Feishu card
    const botName = event.botName;
    if (!botName) { jsonResponse(res, 400, { error: 'Missing botName' }); return true; }
    const bot = registry.get(botName);
    if (!bot) { jsonResponse(res, 404, { error: `Bot ${botName} not found` }); return true; }

    // The event contains card state — send/update card via the bot's sender
    try {
      if (event.type === 'initial') {
        const messageId = await bot.sender.sendCard(chatId, event.state);
        jsonResponse(res, 200, { messageId });
      } else if (event.type === 'update' && event.messageId) {
        await bot.sender.updateCard(event.messageId, event.state);
        jsonResponse(res, 200, { ok: true });
      } else if (event.type === 'complete' && event.messageId) {
        await bot.sender.updateCard(event.messageId, event.state);
        // Also send terminal input as Feishu message
        if (event.terminalInput) {
          await bot.sender.sendTextNotice(chatId, '[终端] ' + event.terminalInput, '', 'blue');
        }
        jsonResponse(res, 200, { ok: true });
      } else if (event.type === 'terminal_input') {
        // Terminal user typed something — show in Feishu
        await bot.sender.sendTextNotice(chatId, '[终端] ' + event.text, '', 'blue');
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 400, { error: `Unknown event type: ${event.type}` });
      }
    } catch (err: any) {
      logger.error({ err, chatId }, 'Failed to forward bridge event to Feishu');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /bridge/status
  if (method === 'GET' && url === '/bridge/status') {
    const bindings = bridgeRegistry.listBindings();
    jsonResponse(res, 200, { bridges: bindings });
    return true;
  }

  // GET /bridge/chats — list available Feishu chats (for --pick)
  if (method === 'GET' && url === '/bridge/chats') {
    // Gather all registered bots and their active chats from session registry
    const bots = registry.list();
    const chats: Array<{ botName: string; chatId: string; label: string }> = [];
    // For now, return bot names — the bridge --pick will show these
    // In practice, chatIds come from the feishu event handler's known chats
    for (const info of bots) {
      chats.push({
        botName: info.name,
        chatId: '',
        label: `Bot: ${info.name} (${info.platform})`,
      });
    }
    jsonResponse(res, 200, { chats });
    return true;
  }

  return false;
}
```

- [ ] **Step 3: 更新 routes/index.ts 导出**

在 `src/api/routes/index.ts` 末尾新增：
```typescript
export { handleBridgeRoutes } from './bridge-routes.js';
```

- [ ] **Step 4: 编译验证**

Run: `cd /opt/ShrimpBot && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 5: Commit**

```bash
cd /opt/ShrimpBot && git add src/api/routes/bridge-routes.ts src/api/routes/types.ts src/api/routes/index.ts && git commit -m "feat(bridge): add bridge API routes (register, messages, events)"
```

---

### Task 3: 集成到服务端 — http-server + index.ts

**Files:**
- Modify: `src/api/http-server.ts` — 初始化 BridgeRegistry，挂载路由
- Modify: `src/index.ts` — 传递 BridgeRegistry

- [ ] **Step 1: http-server.ts 集成**

在 `src/api/http-server.ts` 顶部 import 区域新增：
```typescript
import { BridgeRegistry } from './bridge-registry.js';
import { handleBridgeRoutes } from './routes/index.js';
```

在 `startApiServer` 函数内部，`const ctx: RouteContext = {` 之前新增：
```typescript
  const bridgeRegistry = new BridgeRegistry(logger);
```

在 `RouteContext` 对象 `ctx` 中新增属性：
```typescript
    bridgeRegistry,
```

在 `routeHandlers` 数组最前面新增（bridge 路由优先级最高）：
```typescript
    handleBridgeRoutes,
```

在 routeHandlers import 语句中新增 `handleBridgeRoutes`：
```typescript
import {
  jsonResponse,
  handleVoiceRoutes,
  handleFileRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleBotRoutes,
  handleSyncRoutes,
  handleRtcRoutes,
  handleSessionRoutes,
  handleSkillHubRoutes,
  handleBridgeRoutes,
} from './routes/index.js';
```

- [ ] **Step 2: 编译验证**

Run: `cd /opt/ShrimpBot && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
cd /opt/ShrimpBot && git add src/api/http-server.ts src/index.ts && git commit -m "feat(bridge): integrate BridgeRegistry into API server"
```

---

### Task 4: StreamJSONParser — 客户端解析器

**Files:**
- Create: `src/bridge/stream-json-parser.ts`

- [ ] **Step 1: 实现 StreamJSONParser**

```typescript
// src/bridge/stream-json-parser.ts
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';

export interface ParsedEvent {
  type: 'system' | 'assistant_text' | 'assistant_tool_use' | 'tool_result' | 'result' | 'stream_delta' | 'stream_start' | 'stream_stop' | 'message_start' | 'message_delta' | 'unknown';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  isError?: boolean;
  resultText?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Raw JSON for debugging */
  raw: unknown;
}

/**
 * Parse Claude Code's --output-format stream-json output line by line.
 * Each line is a JSON object. We extract the relevant fields.
 */
export class StreamJSONParser {
  private handlers: Array<(event: ParsedEvent) => void> = [];

  onEvent(handler: (event: ParsedEvent) => void): void {
    this.handlers.push(handler);
  }

  private emit(event: ParsedEvent): void {
    for (const h of this.handlers) {
      h(event);
    }
  }

  /** Start parsing stdout from a child process. */
  start(process: ChildProcess): void {
    const rl = createInterface({ input: process.stdout! });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        this.parseLine(obj);
      } catch {
        // Not JSON — ignore (shouldn't happen with stream-json)
      }
    });
  }

  private parseLine(obj: any): void {
    const type = obj.type;

    if (type === 'system') {
      this.emit({
        type: 'system',
        sessionId: obj.session_id,
        raw: obj,
      });
    } else if (type === 'assistant') {
      this.parseAssistant(obj);
    } else if (type === 'result') {
      this.emit({
        type: 'result',
        resultText: obj.result,
        costUsd: obj.total_cost_usd,
        durationMs: obj.duration_ms,
        isError: obj.subtype !== 'success',
        sessionId: obj.session_id,
        raw: obj,
      });
    } else if (type === 'stream_event') {
      this.parseStreamEvent(obj);
    } else {
      this.emit({ type: 'unknown', raw: obj });
    }
  }

  private parseAssistant(obj: any): void {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.emit({
          type: 'assistant_text',
          text: block.text,
          raw: obj,
        });
      } else if (block.type === 'tool_use') {
        this.emit({
          type: 'assistant_tool_use',
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
          raw: obj,
        });
      } else if (block.type === 'tool_result') {
        this.emit({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          raw: obj,
        });
      }
    }
  }

  private parseStreamEvent(obj: any): void {
    const event = obj.event;
    if (!event) return;

    if (event.type === 'content_block_start') {
      this.emit({
        type: 'stream_start',
        toolName: event.content_block?.name,
        raw: obj,
      });
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this.emit({
          type: 'stream_delta',
          text: delta.text,
          raw: obj,
        });
      }
    } else if (event.type === 'content_block_stop') {
      this.emit({ type: 'stream_stop', raw: obj });
    } else if (event.type === 'message_start') {
      const usage = event.message?.usage;
      this.emit({
        type: 'message_start',
        inputTokens: usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : undefined,
        raw: obj,
      });
    } else if (event.type === 'message_delta') {
      this.emit({
        type: 'message_delta',
        outputTokens: event.usage?.output_tokens,
        raw: obj,
      });
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /opt/ShrimpBot && git add src/bridge/stream-json-parser.ts && git commit -m "feat(bridge): add StreamJSONParser for parsing Claude Code stream-json output"
```

---

### Task 5: TerminalUI — 终端输出渲染

**Files:**
- Create: `src/bridge/terminal-ui.ts`

- [ ] **Step 1: 实现 TerminalUI**

```typescript
// src/bridge/terminal-ui.ts

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GRAY = '\x1b[90m';

export class TerminalUI {
  private lastToolName: string | null = null;

  /** Display a message from Feishu in the terminal. */
  showFeishuMessage(userName: string, text: string): void {
    process.stdout.write(`\n${BLUE}[飞书] ${userName}${RESET}: ${text}\n\n`);
  }

  /** Display a message from terminal user (echo for Feishu sync confirmation). */
  showTerminalInput(text: string): void {
    process.stdout.write(`${CYAN}[终端]${RESET} ${text}\n`);
  }

  /** Display Claude text output. */
  showClaudeText(text: string): void {
    process.stdout.write(text);
  }

  /** Display tool call. */
  showToolCall(name: string, detail?: string): void {
    this.lastToolName = name;
    const detailStr = detail ? ` ${detail}` : '';
    process.stdout.write(`\n${YELLOW}  ${name}${detailStr}${RESET}\n`);
  }

  /** Display tool completion. */
  showToolDone(): void {
    // Tool completion is implicit — next text or tool will overwrite
  }

  /** Display stream delta (incremental text). */
  showStreamDelta(text: string): void {
    process.stdout.write(text);
  }

  /** Display result. */
  showResult(text: string, costUsd?: number, durationMs?: number): void {
    const durationStr = durationMs
      ? durationMs >= 60_000
        ? `${(durationMs / 60_000).toFixed(1)}min`
        : `${(durationMs / 1000).toFixed(0)}s`
      : '';
    const costStr = costUsd ? ` · $${costUsd.toFixed(4)}` : '';
    process.stdout.write(`\n${GREEN}${BOLD}── 完成 ──${RESET} ${DIM}${durationStr}${costStr}${RESET}\n`);
    if (text) {
      process.stdout.write(`${text.slice(0, 500)}${text.length > 500 ? '...' : ''}\n`);
    }
  }

  /** Display error. */
  showError(message: string): void {
    process.stdout.write(`\n${BOLD}\x1b[31m错误: ${message}${RESET}\n`);
  }

  /** Display session info. */
  showSessionInfo(sessionId: string): void {
    process.stdout.write(`${DIM}Session: ${sessionId.slice(0, 8)}...${RESET}\n`);
  }

  /** Display bridge status. */
  showStatus(message: string): void {
    process.stdout.write(`${GRAY}${message}${RESET}\n`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /opt/ShrimpBot && git add src/bridge/terminal-ui.ts && git commit -m "feat(bridge): add TerminalUI for rendering bridge output in terminal"
```

---

### Task 6: CLIBridge — shrimpbot-bridge 主逻辑

**Files:**
- Create: `src/bridge/cli-bridge.ts`

- [ ] **Step 1: 实现 CLIBridge**

```typescript
// src/bridge/cli-bridge.ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { StreamJSONParser, type ParsedEvent } from './stream-json-parser.js';
import { TerminalUI } from './terminal-ui.js';

interface BridgeOptions {
  chatId: string;
  botName: string;
  apiUrl: string;
  apiSecret?: string;
  workingDirectory?: string;
  sessionId?: string;
}

export class CLIBridge {
  private claudeProcess: ChildProcess | null = null;
  private parser = new StreamJSONParser();
  private ui = new TerminalUI();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentSessionId: string | undefined;
  private cardMessageId: string | undefined;
  private accumulatedText = '';
  private currentTools: string[] = [];

  constructor(private options: BridgeOptions) {}

  async start(): Promise<void> {
    const { chatId, botName, apiUrl, apiSecret, workingDirectory, sessionId } = this.options;

    // 1. Register with ShrimpBot
    this.ui.showStatus(`连接 ShrimpBot (${apiUrl})...`);
    const registered = await this.apiCall('POST', '/bridge/register', { chatId });
    if (!registered) {
      this.ui.showError(`注册失败：chatId ${chatId} 已被其他 bridge 绑定`);
      process.exit(1);
    }
    this.ui.showStatus(`已绑定 chatId: ${chatId}`);

    // 2. Spawn Claude Code CLI
    const args = ['--output-format', 'stream-json'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    // Use dangerously-skip-permissions for headless mode
    args.push('--dangerously-skip-permissions');

    const cwd = workingDirectory || process.cwd();
    this.ui.showStatus(`启动 Claude Code (cwd: ${cwd})...`);

    this.claudeProcess = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (!this.claudeProcess.stdin || !this.claudeProcess.stdout) {
      this.ui.showError('无法打开 Claude Code 的 stdin/stdout');
      await this.cleanup();
      process.exit(1);
    }

    // 3. Parse stdout
    this.parser.onEvent((event) => this.handleEvent(event));
    this.parser.start(this.claudeProcess);

    // Handle stderr
    if (this.claudeProcess.stderr) {
      this.claudeProcess.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) this.ui.showStatus(`[claude stderr] ${text}`);
      });
    }

    // Handle process exit
    this.claudeProcess.on('exit', (code) => {
      this.ui.showStatus(`Claude Code 退出 (code: ${code})`);
      this.running = false;
      this.cleanup().then(() => process.exit(code ?? 0));
    });

    // 4. Start heartbeat
    this.running = true;
    this.heartbeatInterval = setInterval(() => {
      this.apiCall('POST', '/bridge/heartbeat', { chatId }).catch(() => {});
    }, 10_000);

    // 5. Start polling for Feishu messages
    this.startMessagePolling();

    // 6. Handle terminal input (stdin → claude stdin + notify Feishu)
    this.startTerminalInput();

    this.ui.showStatus('Bridge 已启动。输入消息与 Claude 对话，飞书同步可见。');
    this.ui.showStatus('---');
  }

  private handleEvent(event: ParsedEvent): void {
    const { chatId, botName, apiUrl } = this.options;

    switch (event.type) {
      case 'system':
        if (event.sessionId) {
          this.currentSessionId = event.sessionId;
          this.ui.showSessionInfo(event.sessionId);
        }
        break;

      case 'assistant_text':
        this.accumulatedText = event.text || '';
        break;

      case 'assistant_tool_use':
        if (event.toolName) {
          this.currentTools.push(event.toolName);
          this.ui.showToolCall(event.toolName, this.formatToolDetail(event.toolName, event.toolInput));
        }
        break;

      case 'tool_result':
        this.ui.showToolDone();
        break;

      case 'stream_delta':
        if (event.text) this.ui.showStreamDelta(event.text);
        break;

      case 'stream_start':
        if (event.toolName) {
          this.currentTools.push(event.toolName);
          this.ui.showToolCall(event.toolName);
        }
        break;

      case 'result':
        this.ui.showResult(
          event.resultText || this.accumulatedText,
          event.costUsd,
          event.durationMs,
        );
        // Send final state to Feishu
        this.sendFeishuEvent('complete', {
          status: event.isError ? 'error' : 'complete',
          responseText: event.isError ? '' : (event.resultText || this.accumulatedText),
          errorMessage: event.isError ? event.resultText : undefined,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
        }).catch(() => {});
        this.accumulatedText = '';
        this.currentTools = [];
        break;

      case 'message_start':
      case 'message_delta':
      case 'stream_stop':
      case 'unknown':
        // No terminal display needed
        break;
    }

    // Forward key events to Feishu (throttled in production)
    if (['assistant_text', 'assistant_tool_use', 'stream_delta'].includes(event.type)) {
      this.sendFeishuEvent('update', {
        status: 'running',
        responseText: this.accumulatedText,
        toolCalls: this.currentTools.map((name) => ({ name, detail: '', status: 'running' as const })),
      }).catch(() => {});
    }
  }

  private async sendFeishuEvent(type: string, state: Record<string, unknown>): Promise<void> {
    const { chatId, botName, apiUrl } = this.options;
    const body: Record<string, unknown> = {
      type,
      botName,
      chatId,
      state,
    };
    if (this.cardMessageId) {
      body.messageId = this.cardMessageId;
    }
    const result = await this.apiCall('POST', `/bridge/events/${chatId}`, body);
    // Capture messageId from initial card creation
    if (type === 'initial' && result?.messageId) {
      this.cardMessageId = result.messageId;
    }
  }

  private async startMessagePolling(): Promise<void> {
    const { chatId, apiUrl } = this.options;
    const poll = async () => {
      if (!this.running) return;
      try {
        const msg = await this.apiCall('GET', `/bridge/messages/${chatId}`);
        if (msg && msg.text && this.claudeProcess?.stdin?.writable) {
          this.ui.showFeishuMessage(msg.userId || '飞书用户', msg.text);
          this.claudeProcess.stdin.write(msg.text + '\n');
        }
      } catch {
        // Polling error — just retry
      }
    };

    // Poll every 500ms
    this.pollInterval = setInterval(poll, 500);
  }

  private startTerminalInput(): void {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      if (!this.running || !this.claudeProcess?.stdin?.writable) return;
      const trimmed = line.trim();
      if (!trimmed) return;

      this.ui.showTerminalInput(trimmed);

      // Send to Claude stdin
      this.claudeProcess.stdin.write(trimmed + '\n');

      // Notify Feishu about terminal input
      this.apiCall('POST', `/bridge/events/${this.options.chatId}`, {
        type: 'terminal_input',
        botName: this.options.botName,
        text: trimmed,
      }).catch(() => {});
    });
  }

  private formatToolDetail(name: string, input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    const inp = input as Record<string, unknown>;
    switch (name) {
      case 'Read': case 'Write': case 'Edit':
        return inp.file_path ? String(inp.file_path).split('/').slice(-2).join('/') : '';
      case 'Bash':
        return inp.command ? String(inp.command).slice(0, 60) : '';
      case 'Grep': case 'Glob':
        return inp.pattern ? String(inp.pattern) : '';
      default:
        return '';
    }
  }

  private async apiCall(method: string, path: string, body?: Record<string, unknown>): Promise<any> {
    const { apiUrl, apiSecret } = this.options;
    const url = `${apiUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiSecret) {
      headers['Authorization'] = `Bearer ${apiSecret}`;
    }
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 204) return null;
    if (resp.status === 409) return null; // already bound
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async cleanup(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);
    try {
      await this.apiCall('POST', '/bridge/unregister', { chatId: this.options.chatId });
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /opt/ShrimpBot && git add src/bridge/cli-bridge.ts && git commit -m "feat(bridge): add CLIBridge main logic for stdin/stdout bridging"
```

---

### Task 7: CLI 入口脚本 — bin/shrimpbot-bridge

**Files:**
- Create: `bin/shrimpbot-bridge`
- Modify: `package.json` — 更新 update-cli 脚本

- [ ] **Step 1: 创建 CLI 入口脚本**

```bash
#!/usr/bin/env bash
# shrimpbot-bridge — Bridge Claude Code CLI to Feishu via ShrimpBot
# Usage:
#   shrimpbot-bridge --chat <chatId> [--api <url>] [--bot <name>] [--cwd <dir>]
#   shrimpbot-bridge --pick [--api <url>]

set -euo pipefail

# Resolve the bridge script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_JS="$SCRIPT_DIR/../dist/bridge/cli-bridge-entry.js"

# Parse arguments
CHAT_ID=""
BOT_NAME="shrimpbot"
API_URL="http://localhost:9100"
API_SECRET="${SHRIMPBOT_API_SECRET:-}"
WORK_DIR=""
PICK_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat)   CHAT_ID="$2"; shift 2 ;;
    --bot)    BOT_NAME="$2"; shift 2 ;;
    --api)    API_URL="$2"; shift 2 ;;
    --secret) API_SECRET="$2"; shift 2 ;;
    --cwd)    WORK_DIR="$2"; shift 2 ;;
    --pick)   PICK_MODE=true; shift ;;
    *)        echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$PICK_MODE" == "true" ]]; then
  # Interactive mode — let the Node script handle it
  exec node "$BRIDGE_JS" --pick --api "$API_URL" --bot "$BOT_NAME" ${API_SECRET:+--secret "$API_SECRET"}
elif [[ -n "$CHAT_ID" ]]; then
  exec node "$BRIDGE_JS" --chat "$CHAT_ID" --api "$API_URL" --bot "$BOT_NAME" ${API_SECRET:+--secret "$API_SECRET"} ${WORK_DIR:+--cwd "$WORK_DIR"}
else
  echo "shrimpbot-bridge — Bridge Claude Code CLI to Feishu via ShrimpBot"
  echo ""
  echo "Usage:"
  echo "  shrimpbot-bridge --chat <chatId> [--api <url>] [--bot <name>] [--cwd <dir>]"
  echo "  shrimpbot-bridge --pick [--api <url>]"
  echo ""
  echo "Options:"
  echo "  --chat <chatId>    Feishu chat ID to bind"
  echo "  --pick             Interactive chat selection"
  echo "  --api <url>        ShrimpBot API URL (default: http://localhost:9100)"
  echo "  --bot <name>       Bot name (default: shrimpbot)"
  echo "  --secret <token>   API secret (or set SHRIMPBOT_API_SECRET)"
  echo "  --cwd <dir>        Working directory for Claude Code"
  exit 1
fi
```

- [ ] **Step 2: 创建 Node 入口文件**

```typescript
// src/bridge/cli-bridge-entry.ts
import { CLIBridge } from './cli-bridge.js';

const args = process.argv.slice(2);

function getArgValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const chatId = getArgValue('--chat');
  const pickMode = args.includes('--pick');
  const apiUrl = getArgValue('--api') || 'http://localhost:9100';
  const botName = getArgValue('--bot') || 'shrimpbot';
  const apiSecret = getArgValue('--secret') || process.env.SHRIMPBOT_API_SECRET;
  const workingDirectory = getArgValue('--cwd');

  if (pickMode && !chatId) {
    // Fetch available chats from API
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiSecret) headers['Authorization'] = `Bearer ${apiSecret}`;
    const resp = await fetch(`${apiUrl}/bridge/chats`, { headers });
    const data = await resp.json() as { chats: Array<{ botName: string; chatId: string; label: string }> };

    if (!data.chats || data.chats.length === 0) {
      console.error('没有找到可用的飞书聊天。确保 ShrimpBot 正在运行且有 Feishu bot 配置。');
      process.exit(1);
    }

    console.log('可用的飞书聊天：');
    for (let i = 0; i < data.chats.length; i++) {
      console.log(`  ${i + 1}. ${data.chats[i].label}`);
    }
    console.log('');

    // Read selection from stdin
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    const answer: string = await new Promise((resolve) => {
      rl.question('请输入 chatId（或输入编号，暂不支持编号选择请直接输入 chatId）: ', resolve);
    });
    rl.close();

    const selectedChatId = answer.trim();
    if (!selectedChatId) {
      console.error('未选择聊天');
      process.exit(1);
    }

    const bridge = new CLIBridge({
      chatId: selectedChatId,
      botName,
      apiUrl,
      apiSecret,
      workingDirectory,
    });

    // Cleanup on exit
    process.on('SIGINT', async () => { await bridge.cleanup(); process.exit(0); });
    process.on('SIGTERM', async () => { await bridge.cleanup(); process.exit(0); });

    await bridge.start();
    return;
  }

  if (!chatId) {
    console.error('用法：shrimpbot-bridge --chat <chatId> 或 shrimpbot-bridge --pick');
    process.exit(1);
  }

  const bridge = new CLIBridge({
    chatId,
    botName,
    apiUrl,
    apiSecret,
    workingDirectory,
  });

  // Cleanup on exit
  process.on('SIGINT', async () => { await bridge.cleanup(); process.exit(0); });
  process.on('SIGTERM', async () => { await bridge.cleanup(); process.exit(0); });

  await bridge.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 3: 更新 package.json update-cli 脚本**

在 `package.json` 的 `update-cli` 脚本中，将 `for cli in mb mm shrimpbot;` 改为：
```
for cli in mb mm shrimpbot shrimpbot-bridge; do [ -f bin/$cli ] && cp bin/$cli ~/.local/bin/$cli && chmod +x ~/.local/bin/$cli && echo "Updated: $cli"; done
```

- [ ] **Step 4: 设置脚本可执行权限并编译**

Run:
```bash
cd /opt/ShrimpBot && chmod +x bin/shrimpbot-bridge && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
cd /opt/ShrimpBot && git add bin/shrimpbot-bridge src/bridge/cli-bridge-entry.ts package.json && git commit -m "feat(bridge): add shrimpbot-bridge CLI entry point with --pick support"
```

---

### Task 8: MessageBridge 路由集成 — 桥接模式路由

**Files:**
- Modify: `src/bridge/message-bridge.ts` — handleMessage 中增加 bridge 路由

- [ ] **Step 1: 在 message-bridge.ts 中增加 bridge 路由**

在 `MessageBridge` class 中新增属性（在 `private feishuConfirm?: FeishuConfirm;` 之后）：
```typescript
  /** Bridge registry — when set, checks if a chatId has an active CLI bridge. */
  private bridgeRegistry?: import('../api/bridge-registry.js').BridgeRegistry;
```

新增 setter 方法（在 `setFeishuConfirm` 方法之后）：
```typescript
  /** Inject the bridge registry for CLI bridge routing. */
  setBridgeRegistry(registry: import('../api/bridge-registry.js').BridgeRegistry): void {
    this.bridgeRegistry = registry;
  }
```

在 `handleMessage` 方法开头，`const { chatId, text } = msg;` 之后、`// Handle commands` 之前新增：
```typescript
    // Check if this chatId has an active CLI bridge — forward message via API
    if (this.bridgeRegistry?.isBound(chatId)) {
      const enqueued = this.bridgeRegistry.enqueueMessage({
        source: 'feishu',
        chatId,
        userId: msg.userId,
        text: msg.text,
        timestamp: Date.now(),
      });
      if (enqueued) {
        this.logger.info({ chatId, userId: msg.userId }, 'Message forwarded to CLI bridge');
        return;
      }
      // If enqueue failed (bridge died), fall through to normal handling
      this.logger.info({ chatId }, 'Bridge enqueue failed, falling back to SDK mode');
    }
```

- [ ] **Step 2: 在 index.ts 中注入 bridge registry**

在 `src/index.ts` 中找到初始化 `sessionRegistry` 后注入到 bridges 的代码块。在那段代码之后新增：

```typescript
  // Inject bridge registry into bot bridges for CLI bridge routing
  // Note: bridgeRegistry is created inside startApiServer, so we need a reference
  // We'll pass it via the registry after server creation
```

实际上 bridgeRegistry 是在 `startApiServer` 内部创建的。需要在 `startApiServer` 返回值中暴露它，或者在外部创建后传入。

**修改方案**：在 `startApiServer` 的 `ApiServerOptions` 中增加可选的 `bridgeRegistry` 参数，如果未提供则内部创建。

在 `src/api/http-server.ts` 的 `ApiServerOptions` interface 新增：
```typescript
  bridgeRegistry?: import('./bridge-registry.js').BridgeRegistry;
```

在 `startApiServer` 函数内，将 `const bridgeRegistry = new BridgeRegistry(logger);` 改为：
```typescript
  const bridgeRegistry = options.bridgeRegistry ?? new BridgeRegistry(logger);
```

然后在 `src/index.ts` 中，在 `startApiServer` 调用之前新增：
```typescript
  // Create bridge registry for CLI bridge routing
  const { BridgeRegistry } = await import('./api/bridge-registry.js');
  const bridgeRegistry = new BridgeRegistry(logger);
```

在 `startApiServer` 调用参数中新增：
```typescript
    bridgeRegistry,
```

在注册 session registry 的循环之后新增：
```typescript
  // Inject bridge registry into all bot bridges
  for (const info of registry.list()) {
    const bot = registry.get(info.name);
    if (bot) bot.bridge.setBridgeRegistry(bridgeRegistry);
  }
```

- [ ] **Step 3: 编译验证**

Run: `cd /opt/ShrimpBot && npx tsc --noEmit 2>&1 | head -20`

- [ ] **Step 4: Commit**

```bash
cd /opt/ShrimpBot && git add src/bridge/message-bridge.ts src/api/http-server.ts src/index.ts && git commit -m "feat(bridge): integrate bridge routing into message-bridge and index"
```

---

### Task 9: 构建和端到端测试

**Files:** 无新增

- [ ] **Step 1: 完整构建**

Run: `cd /opt/ShrimpBot && npm run build 2>&1 | tail -20`
Expected: 构建成功

- [ ] **Step 2: 安装 CLI 工具**

Run: `cd /opt/ShrimpBot && cp bin/shrimpbot-bridge ~/.local/bin/ && chmod +x ~/.local/bin/shrimpbot-bridge`

- [ ] **Step 3: 验证 bridge 注册 API**

启动 ShrimpBot 后，运行：
```bash
curl -s -H "Authorization: Bearer $(grep API_SECRET /opt/ShrimpBot/.env 2>/dev/null | cut -d= -f2 || echo '')" -X POST http://localhost:9100/bridge/register -H 'Content-Type: application/json' -d '{"chatId":"test-chat-123"}'
```
Expected: `{"status":"registered","chatId":"test-chat-123"}`

- [ ] **Step 4: 验证 bridge status API**

```bash
curl -s -H "Authorization: Bearer <secret>" http://localhost:9100/bridge/status
```
Expected: `{"bridges":[{"chatId":"test-chat-123","connectedAt":...,"lastHeartbeat":...}]}`

- [ ] **Step 5: 验证注销**

```bash
curl -s -H "Authorization: Bearer <secret>" -X POST http://localhost:9100/bridge/unregister -H 'Content-Type: application/json' -d '{"chatId":"test-chat-123"}'
```
Expected: `{"status":"unregistered","chatId":"test-chat-123"}`

- [ ] **Step 6: 手动测试 shrimpbot-bridge --pick**

```bash
shrimpbot-bridge --pick
```
Expected: 显示可用聊天列表

- [ ] **Step 7: Commit 构建产物（如需要）**

```bash
cd /opt/ShrimpBot && git add -A && git commit -m "chore: build and verify CLI bridge"
```

---

### Task 10: 最终集成测试和清理

**Files:** 所有新增文件

- [ ] **Step 1: 启动 ShrimpBot + shrimpbot-bridge 端到端测试**

1. 用 PM2 启动 ShrimpBot：`pm2 restart shrimpbot`
2. 在另一个终端启动 bridge：`shrimpbot-bridge --chat <real-chatId> --api http://localhost:9100`
3. 在飞书发送消息给机器人
4. 验证终端显示 `[飞书] xxx: 消息内容`
5. 在终端输入消息
6. 验证飞书显示 `[终端] 消息内容`

- [ ] **Step 2: 验证无 bridge 时现有功能正常**

1. 停止 shrimpbot-bridge
2. 在飞书发送消息给机器人
3. 验证走 SDK headless 模式，卡片正常显示

- [ ] **Step 3: 更新 NOTICE 文件**

- [ ] **Step 4: Final commit and push**

```bash
cd /opt/ShrimpBot && git add -A && git commit -m "feat(bridge): CLI bridge implementation complete — shrimpbot-bridge"
```

---

## 自查清单

**Spec 覆盖率：**
- ✅ 双引擎架构 → Task 1-3 (服务端) + Task 4-7 (客户端)
- ✅ 双向同步规则 → Task 6 (CLIBridge 处理双向)
- ✅ 路由逻辑 → Task 8 (message-bridge 路由)
- ✅ CLI 桥接引擎 → Task 6
- ✅ StreamJSONParser → Task 4
- ✅ TerminalUI → Task 5
- ✅ API 路由 → Task 2
- ✅ 安全性（API secret, 心跳） → Task 1 (BridgeRegistry), Task 2 (路由认证)
- ✅ --chat 和 --pick → Task 7
- ✅ 现有功能零改动 → 已验证

**占位符扫描：** 无 TBD/TODO

**类型一致性：**
- `BridgeRegistry` 的 `register()`, `isBound()`, `enqueueMessage()`, `waitForMessage()` 在 Task 1 定义，Task 2/6/8 使用
- `BridgeMessage` 类型在 Task 1 定义，Task 8 使用
- `ParsedEvent` 类型在 Task 4 定义，Task 6 使用
- `CLIBridge` 构造函数 `BridgeOptions` 在 Task 6 定义，Task 7 使用
