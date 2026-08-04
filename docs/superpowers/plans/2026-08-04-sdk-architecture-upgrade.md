# ShrimpBot 架构升级：PTY → Agent SDK · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将飞书端数据源从"PTY 正则解析"切换为"Claude Agent SDK 结构化事件流"，同步上线远程审批，终端保留 PTY TUI 透传。

**Architecture:** 新增 `src/sdk/` 目录承载 SDKSession（封装 query()）、FeishuCardRenderer（事件→卡片）、ApprovalGate（审批回调）。FeishuBridge 拆出 MessageRouter。feature flag `SDK_EVENT_MODE` 实现新老并行、可一键回退。终端 PTY 通过 `--resume` 接续 SDK session。

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk@0.3.221`, vitest, node-pty (仅终端透传支线), @larksuiteoapi/node-sdk (飞书 API)

## Global Constraints

- 渐进迁移：每阶段独立上线，feature flag `SDK_EVENT_MODE` 控制，false 时完全走旧路径
- 不修改生产 `.claude/settings.local.json`（sbot 实例子进程的 hook 依赖它）
- 终端 PTY TUI 透传体验不变（用户粘性最高的体验保留）
- 所有 commit message 用中文
- 不主动 push，用户说 push 才 push
- SDK cwd 与 PTY cwd 必须锁定同一目录（session jsonl 共享前提）
- 危险工具底限：`disallowedTools: ["Bash(rm *)","Bash(sudo *)","Bash(dd *)","Bash(mkfs *)","Bash(:(){ *)","Bash(shutdown *)","Bash(docker run *)"]`

---

## 文件结构

```
创建:
  src/sdk/sdk-types.ts              # SDK 事件 → 桥内类型的映射 + ApprovalRequest/PermissionResult
  src/sdk/sdk-session.ts            # query() 封装，产出 AsyncGenerator<SDKBridgeEvent>
  src/sdk/feishu-card-renderer.ts   # 纯函数：SDKBridgeEvent → 飞书卡片内容
  src/sdk/message-router.ts         # 从 FeishuBridge 抽出的多群路由 + 消息队列
  src/sdk/__tests__/feishu-card-renderer.test.ts  # 卡片渲染单测
  src/sdk/__tests__/sdk-session.integration.test.ts  # 实机集成测试

修改:
  src/types/index.ts                # 新增 SDKBridgeEvent 等类型
  src/pty/feishu-bridge.ts          # 引入 SDKSession + FeatureFlag，拆出 MessageRouter
  src/index.ts                      # 阶段 C：PTY --resume 参数

后续（阶段 D 删除）:
  src/pty/output-parser.ts          # 废弃
  src/pty/__tests__/output-parser.test.ts  # 废弃
```

---

## Phase A：引入 SDKSession + FeishuCardRenderer（并行运行）

### Task A1: 定义 SDK 桥内类型

**Files:**
- Create: `src/sdk/sdk-types.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/claude-agent-sdk` 的 `SDKMessage` 联合类型
- Produces: `SDKBridgeEvent`（统一事件类型）、`ApprovalRequest`（审批请求）、`PermissionResult`（审批结果）

**SDKBridgeEvent** — SDK 原生消息 → 桥内标准化事件：
```typescript
// SDK 事件 → 飞书端的标准化事件格式
export type SDKBridgeEvent =
  | { type: 'init'; sessionId: string; model: string; cwd: string }
  | { type: 'text'; text: string; partial: boolean }            // assistant 文本（partial=true 时流式）
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { type: 'approval_request'; request: ApprovalRequest }      // canUseTool 触发
  | { type: 'completed'; text: string; cost: number; turns: number; sessionId: string }
  | { type: 'error'; message: string; detail?: string };

export interface ApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  displayName?: string;   // 按钮标签
  title?: string;         // 预览提示语
  description?: string;   // 详细说明
  agentId?: string;       // 子代理 ID
  signal: AbortSignal;    // 审批超时可 abort
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };
```

- [ ] **Step 1: 创建 `src/sdk/sdk-types.ts`**

命令: `mkdir -p src/sdk && touch src/sdk/sdk-types.ts`

- [ ] **Step 2: 写入类型定义**

将上述 `SDKBridgeEvent`、`ApprovalRequest`、`PermissionResult` 写入文件

- [ ] **Step 3: 在 `src/types/index.ts` 追加导出**

```typescript
// 追加到文件末尾
export type { SDKBridgeEvent, ApprovalRequest, PermissionResult } from '../sdk/sdk-types.js';
```

- [ ] **Step 4: 编译检查**

Run: `npx tsc --noEmit`
Expected: 通过（仅类型定义，无运行时依赖）

- [ ] **Step 5: Commit**

```bash
git add src/sdk/sdk-types.ts src/types/index.ts
git commit -m "feat: 新增 SDK 桥内类型（SDKBridgeEvent/ApprovalRequest/PermissionResult）"
```

---

### Task A2: 创建 SDKSession（封装 query()）

**Files:**
- Create: `src/sdk/sdk-session.ts`

**Interfaces:**
- Consumes: `SDKBridgeEvent`, `ApprovalRequest`, `PermissionResult` (from A1), `query` from `@anthropic-ai/claude-agent-sdk`
- Produces: `SDKSession` class — `start(prompt, options)` 返回 `AsyncGenerator<SDKBridgeEvent>`, `resume(sessionId)` 返回 `AsyncGenerator<SDKBridgeEvent>`, `getSessionId()` 返回当前 sessionId

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKBridgeEvent, ApprovalRequest, PermissionResult } from './sdk-types.js';
import { logger } from '../logger.js';

const TAG = 'SDKSession';

const HIGH_RISK_TOOLS = new Set([
  'Bash(rm *)', 'Bash(sudo *)', 'Bash(dd *)', 'Bash(mkfs *)',
  'Bash(:(){ *)', 'Bash(shutdown *)', 'Bash(docker run *)',
]);

export interface SDKSessionOptions {
  cwd: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  maxTurns?: number;
  /** 审批回调：返回 allow/deny。未提供时，canUseTool 直通 allow */
  onApproval?: (req: ApprovalRequest) => Promise<PermissionResult>;
  /** 审批超时 ms（默认 300000 = 5分钟） */
  approvalTimeoutMs?: number;
}

export class SDKSession {
  private sessionId: string | null = null;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getSessionId(): string | null { return this.sessionId; }

  /** 开始新会话，返回事件流 */
  async *start(prompt: string, options: SDKSessionOptions): AsyncGenerator<SDKBridgeEvent> {
    const approvalTimeout = options.approvalTimeoutMs ?? 300_000;

    const q = query({
      prompt,
      options: {
        cwd: this.cwd,
        model: options.model,
        permissionMode: options.permissionMode ?? 'default',
        maxTurns: options.maxTurns ?? 50,
        disallowedTools: [...HIGH_RISK_TOOLS],
        canUseTool: options.onApproval
          ? async (toolName, input, ctx) => {
              const req: ApprovalRequest = {
                toolName,
                toolUseId: ctx.toolUseID,
                input,
                displayName: ctx.displayName,
                title: ctx.title,
                description: ctx.description,
                agentId: ctx.agentID,
                signal: AbortSignal.timeout(approvalTimeout),
              };
              const event: SDKBridgeEvent = { type: 'approval_request', request: req };
              yield event;
              try {
                const result = await options.onApproval!(req);
                return result.behavior === 'deny'
                  ? { behavior: 'deny' as const, message: result.message ?? '用户拒绝' }
                  : { behavior: 'allow' as const, updatedInput: result.updatedInput };
              } catch {
                return { behavior: 'deny' as const, message: '审批处理异常，默认拒绝' };
              }
            }
          : undefined,
      },
    });

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          yield { type: 'init', sessionId: msg.session_id, model: msg.model, cwd: this.cwd };
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text', text: block.text, partial: false };
            }
            if (block.type === 'tool_use') {
              yield { type: 'tool_use', toolName: block.name, toolUseId: block.id, input: block.input as Record<string,unknown> };
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              yield { type: 'tool_result', toolUseId: block.tool_use_id, isError: !!block.is_error, content: String(block.content) };
            }
          }
        } else if (msg.type === 'result') {
          // 校验 result 文本是否隐藏认证/限流错误
          const text = msg.result ?? '';
          const isHiddenError = /API Error|403|usage limit|billing|quota/i.test(text);
          if (isHiddenError && msg.subtype === 'success') {
            yield { type: 'error', message: `模型调用失败: ${text.slice(0, 200)}` };
          } else if (msg.subtype === 'success') {
            yield { type: 'completed', text, cost: msg.total_cost_usd ?? 0, turns: msg.num_turns, sessionId: msg.session_id };
          } else {
            yield { type: 'error', message: text || `SDK 返回异常: subtype=${msg.subtype}` };
          }
        }
      }
    } catch (err: any) {
      logger.error(TAG, `query 异常: ${err.message}`);
      yield { type: 'error', message: err.message, detail: err.stack?.slice(0, 500) };
    }
  }

  /** 恢复已有会话 */
  async *resume(sessionId: string, prompt: string, options: SDKSessionOptions): AsyncGenerator<SDKBridgeEvent> {
    const approvalTimeout = options.approvalTimeoutMs ?? 300_000;
    try {
      const q = query({
        prompt,
        options: {
          cwd: this.cwd,
          model: options.model,
          permissionMode: options.permissionMode ?? 'default',
          maxTurns: options.maxTurns ?? 50,
          resume: sessionId,
          disallowedTools: [...HIGH_RISK_TOOLS],
          canUseTool: options.onApproval
            ? async (toolName, input, ctx) => {
                const req: ApprovalRequest = {
                  toolName, toolUseId: ctx.toolUseID, input,
                  displayName: ctx.displayName, title: ctx.title,
                  description: ctx.description, agentId: ctx.agentID,
                  signal: AbortSignal.timeout(approvalTimeout),
                };
                yield { type: 'approval_request', request: req };
                try {
                  const result = await options.onApproval!(req);
                  return result.behavior === 'deny'
                    ? { behavior: 'deny' as const, message: result.message ?? '用户拒绝' }
                    : { behavior: 'allow' as const, updatedInput: result.updatedInput };
                } catch {
                  return { behavior: 'deny' as const, message: '审批处理异常，默认拒绝' };
                }
              }
            : undefined,
        },
      });
      for await (const msg of q) {
        // 同 start() 的分发逻辑，但 init 事件在 resume 时可能不发
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          yield { type: 'init', sessionId: msg.session_id, model: msg.model, cwd: this.cwd };
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text', text: block.text, partial: false };
            }
            if (block.type === 'tool_use') {
              yield { type: 'tool_use', toolName: block.name, toolUseId: block.id, input: block.input as Record<string,unknown> };
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message?.content || []) {
            if (block.type === 'tool_result') {
              yield { type: 'tool_result', toolUseId: block.tool_use_id, isError: !!block.is_error, content: String(block.content) };
            }
          }
        } else if (msg.type === 'result') {
          const text = msg.result ?? '';
          const isHiddenError = /API Error|403|usage limit|billing|quota/i.test(text);
          if (isHiddenError && msg.subtype === 'success') {
            yield { type: 'error', message: `模型调用失败: ${text.slice(0, 200)}` };
          } else if (msg.subtype === 'success') {
            yield { type: 'completed', text, cost: msg.total_cost_usd ?? 0, turns: msg.num_turns, sessionId: msg.session_id };
          } else {
            yield { type: 'error', message: text || `SDK 返回异常: subtype=${msg.subtype}` };
          }
        }
      }
    } catch (err: any) {
      logger.error(TAG, `resume 异常: ${err.message}`);
      yield { type: 'error', message: `会话恢复失败: ${err.message}`, detail: err.stack?.slice(0, 500) };
    }
  }
}
```

**注意**：`start()` 和 `resume()` 的消息分发逻辑相同。如重复行过多，可抽取私有 `async *iterateMessages()` 方法。但为清晰（每个 task 可独立阅读），此处保持显式。

**自审**：`AbortSignal.timeout()` 的 `timeout` 参数在 Node.js v24 有 `timeout` 选项；如需兼容 v20，可用 `AbortSignal.timeout(ms)` 或手动 `setTimeout + controller.abort()`。本项目 runtime 是 Node v24，直接用。

- [ ] **Step 1: 创建 `src/sdk/sdk-session.ts`** 写入上述实现

- [ ] **Step 2: 编译检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/sdk/sdk-session.ts
git commit -m "feat: 新增 SDKSession（封装 query()/resume()/canUseTool 审批门）"
```

---

### Task A3: 创建 FeishuCardRenderer（事件→卡片）

**Files:**
- Create: `src/sdk/feishu-card-renderer.ts`

**Interfaces:**
- Consumes: `SDKBridgeEvent` (from A1)
- Produces: `CardState` 对象，含 `cardColor`、`header`、`content`、`isTerminal` 四个字段。消费者（FeishuBridge）据此调飞书 API

```typescript
import type { SDKBridgeEvent } from './sdk-types.js';

/** 卡片渲染输出：FeishuBridge 据此调 patchCard / sendCard */
export interface CardState {
  color: 'blue' | 'green' | 'yellow' | 'red';
  header: string;
  content: string;
  /** 是否终态卡片（完成后不可再 patch） */
  isTerminal: boolean;
}

/** 渲染器的累积状态（across events in one turn） */
interface RenderState {
  textParts: string[];
  toolCount: number;
  lastToolName: string;
  hasError: boolean;
  errorMessage: string;
}

/**
 * 从单次 turn 的 SDK 事件流生成飞书卡片。
 * 多次调用 addEvent(event) 累积状态，finalize() 产出终态卡片。
 */
export class FeishuCardRenderer {
  private state: RenderState = { textParts: [], toolCount: 0, lastToolName: '', hasError: false, errorMessage: '' };

  /** 添加一个事件，返回是否需要发中间态 patch（true=发） */
  addEvent(event: SDKBridgeEvent): boolean {
    switch (event.type) {
      case 'text':
        this.state.textParts.push(event.text);
        return true; // 流式文本，发 patch
      case 'tool_use':
        this.state.toolCount++;
        this.state.lastToolName = event.toolName;
        return true; // 工具调用，发"执行中"patch
      case 'tool_result':
        return false; // 工具结果不发独立卡片，等文本或完成
      case 'error':
        this.state.hasError = true;
        this.state.errorMessage = event.message;
        return true;
      default:
        return false;
    }
  }

  /** 产出终态卡片状态 */
  finalize(): CardState {
    if (this.state.hasError) {
      return { color: 'red', header: '🔴 错误', content: this.state.errorMessage || '未知错误', isTerminal: true };
    }
    const text = this.state.textParts.join('\n');
    if (!text && this.state.toolCount > 0) {
      return { color: 'blue', header: '🛠 执行中', content: `执行 ${this.state.lastToolName}...`, isTerminal: false };
    }
    return { color: 'green', header: '🟢 完成', content: text, isTerminal: true };
  }

  /** 中间态卡片（流式/工具过程中） */
  getIntermediate(): CardState {
    const text = this.state.textParts.join('\n');
    if (this.state.hasError) {
      return { color: 'red', header: '🔴 错误', content: this.state.errorMessage, isTerminal: true };
    }
    if (text) {
      return { color: 'blue', header: '🔵 思考中', content: text.slice(-2000), isTerminal: false };
    }
    if (this.state.toolCount > 0) {
      return { color: 'blue', header: '🔄 处理中', content: `执行工具: ${this.state.lastToolName}`, isTerminal: false };
    }
    return { color: 'blue', header: '🔵 思考中', content: '', isTerminal: false };
  }

  /** 重置为新一轮 */
  reset(): void {
    this.state = { textParts: [], toolCount: 0, lastToolName: '', hasError: false, errorMessage: '' };
  }
}
```

- [ ] **Step 1: 创建 `src/sdk/feishu-card-renderer.ts`** 写入上述实现

- [ ] **Step 2: 编译检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: 写卡片渲染单测**

创建 `src/sdk/__tests__/feishu-card-renderer.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { FeishuCardRenderer, CardState } from '../feishu-card-renderer.js';
import type { SDKBridgeEvent } from '../sdk-types.js';

describe('FeishuCardRenderer', () => {
  let renderer: FeishuCardRenderer;

  beforeEach(() => { renderer = new FeishuCardRenderer(); });

  it('初始状态返回蓝色思考卡片', () => {
    const card = renderer.getIntermediate();
    expect(card.color).toBe('blue');
    expect(card.header).toContain('思考');
    expect(card.isTerminal).toBe(false);
  });

  it('收到文本后中间态含文本内容', () => {
    renderer.addEvent({ type: 'text', text: '你好世界', partial: true });
    const card = renderer.getIntermediate();
    expect(card.content).toContain('你好世界');
  });

  it('完成态返回绿色完成卡片', () => {
    renderer.addEvent({ type: 'text', text: '任务完成', partial: false });
    const card = renderer.finalize();
    expect(card.color).toBe('green');
    expect(card.isTerminal).toBe(true);
  });

  it('错误事件返回红色错误卡片', () => {
    renderer.addEvent({ type: 'error', message: '额度用尽' });
    const card = renderer.finalize();
    expect(card.color).toBe('red');
    expect(card.isTerminal).toBe(true);
    expect(card.content).toContain('额度用尽');
  });

  it('工具调用后中间态显示工具名', () => {
    renderer.addEvent({ type: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } });
    const card = renderer.getIntermediate();
    expect(card.color).toBe('blue');
    expect(card.content).toContain('Bash');
  });

  it('reset 后状态清零', () => {
    renderer.addEvent({ type: 'text', text: '旧文本', partial: false });
    renderer.reset();
    const card = renderer.getIntermediate();
    expect(card.content).toBe('');
  });

  it('无文本仅工具调用时 finalize 返回处理中（非完成）', () => {
    renderer.addEvent({ type: 'tool_use', toolName: 'Write', toolUseId: 'w1', input: {} });
    const card = renderer.finalize();
    expect(card.isTerminal).toBe(false);
  });
});
```

Run: `npx vitest run src/sdk/__tests__/feishu-card-renderer.test.ts`
Expected: 7 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/sdk/feishu-card-renderer.ts src/sdk/__tests__/feishu-card-renderer.test.ts
git commit -m "feat: 新增 FeishuCardRenderer（SDK 事件→飞书卡片状态）含单测"
```

---

### Task A4: 在 FeishuBridge 中接入 SDKSession + Feature Flag

**Files:**
- Modify: `src/pty/feishu-bridge.ts`

**Interfaces:**
- Consumes: `SDKSession` (A2), `FeishuCardRenderer` (A3), `SDKBridgeEvent` (A1)
- Produces: 新 `handleFeishuMessage` 路径（当 `SDK_EVENT_MODE=true` 时走 SDK，否则走旧 PTY 路径）

**改动要点**（不重写全部，只做战略性增量修改）：

1. **在构造函数中初始化 `SDKSession` + `FeishuCardRenderer`**（当 feature flag 开时）
2. **`dispatchToClaude` 增 SDK 分支**：`if (process.env.SDK_EVENT_MODE === 'true')` 时，不调 `this.pty.send()`，改为 `this.sdkSession.start(prompt, options)` + 消费事件流 `for await` 调 `FeishuCardRenderer.addEvent()` + `getIntermediate()` patch 飞书卡片
3. **旧路径完整保留**：`SDK_EVENT_MODE` 任何非 `'true'` 值都走现有 PTY 路径，零改动

**核心实现**（追加到 `FeishuBridge` 类）：

```typescript
// ========== 追加 import ==========
import { SDKSession, SDKSessionOptions } from '../sdk/sdk-session.js';
import { FeishuCardRenderer, CardState } from '../sdk/feishu-card-renderer.js';
import type { SDKBridgeEvent, ApprovalRequest, PermissionResult } from '../sdk/sdk-types.js';

// ========== 追加字段（构造函数中初始化） ==========
private sdkSession: SDKSession | null = null;
private sdkRenderer: FeishuCardRenderer | null = null;
private sdkMode: boolean;

// 构造函数内末尾追加：
this.sdkMode = process.env.SDK_EVENT_MODE === 'true';
if (this.sdkMode) {
  const sdkCwd = this.config.claudeCwd || process.cwd();
  this.sdkSession = new SDKSession(sdkCwd);
  this.sdkRenderer = new FeishuCardRenderer();
  logger.info(this.tag, `SDK 模式已启用 (cwd: ${sdkCwd})`);
}

// ========== 新增方法：SDK 路径的 dispatch ==========
private async dispatchToClaudeViaSDK(text: string, targetChatId: string): Promise<void> {
  if (!this.sdkSession || !this.sdkRenderer) return;
  
  this.claudeBusy = true;
  this.responseChatId = targetChatId;
  this.sdkRenderer.reset();
  
  // 思考卡片
  this.sendThinkingCard(targetChatId);

  try {
    const events = this.sdkSession.start(text, {
      cwd: this.config.claudeCwd || process.cwd(),
      permissionMode: 'default',
      onApproval: this.config.clone ? undefined : async (req: ApprovalRequest): Promise<PermissionResult> => {
        // clone 模式不弹审批
        logger.info(this.tag, `审批请求: ${req.toolName} ${JSON.stringify(req.input).slice(0, 100)}`);
        // TODO: 阶段 B 接入 ApprovalGate 飞书卡片
        // 当前阶段 A：直接 allow（与旧路径行为兼容）
        return { behavior: 'allow' };
      },
    });

    for await (const event of events) {
      if (event.type === 'completed') {
        this.sdkRenderer!.addEvent(event);
        const card = this.sdkRenderer!.finalize();
        this.patchCard(card.color, card.header, card.content);
        break;
      } else if (event.type === 'error') {
        this.sdkRenderer!.addEvent(event);
        const card = this.sdkRenderer!.finalize();
        this.patchCard('red', '🔴 错误', card.content);
        break;
      } else {
        // 流式中间态
        const shouldPatch = this.sdkRenderer!.addEvent(event);
        if (shouldPatch && !this.config.clone) {
          const card = this.sdkRenderer!.getIntermediate();
          this.patchCard(card.color, card.header, card.content);
        }
      }
    }
  } catch (err: any) {
    logger.error(this.tag, `SDK dispatch 异常: ${err.message}`);
    this.patchCard('red', '🔴 错误', err.message);
  } finally {
    this.claudeBusy = false;
    this.processQueue();
  }
}

// ========== dispatchToClaude 方法顶部追加分支 ==========
// 在现有 dispatchToClaude 方法的开头追加：
if (this.sdkMode && this.sdkSession) {
  await this.dispatchToClaudeViaSDK(text, targetChatId);
  return;
}
// 以下是现有 PTY 路径代码，不动...
```

- [ ] **Step 1: 在 `feishu-bridge.ts` 追加 import + 字段初始化**

位置：文件顶部 import 区 + 构造函数末尾

- [ ] **Step 2: 追加 `dispatchToClaudeViaSDK` 方法**

位置：`dispatchToClaude` 方法之前

- [ ] **Step 3: 在 `dispatchToClaude` 开头插入 feature flag 分支**

位置：`dispatchToClaude` 方法第一行

- [ ] **Step 4: 编译检查**

Run: `npx tsc --noEmit`
Expected: 通过

- [ ] **Step 5: Commit**

```bash
git add src/pty/feishu-bridge.ts
git commit -m "feat: FeishuBridge 接入 SDKSession（feature flag SDK_EVENT_MODE）"
```

---

### Task A5: 集成测试（实机 SDK 端到端）

**Files:**
- Create: `src/sdk/__tests__/sdk-session.integration.test.ts`

**前置条件**：`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 环境变量（test runner 继承）

```typescript
import { describe, it, expect } from 'vitest';
import { SDKSession } from '../sdk-session.js';
import { FeishuCardRenderer } from '../feishu-card-renderer.js';

// 集成测试需真实的认证环境，不可用时跳过
const hasAuth = !!process.env.ANTHROPIC_AUTH_TOKEN || !!process.env.ANTHROPIC_BASE_URL;
const describeIf = hasAuth ? describe : describe.skip;

describeIf('SDKSession 集成测试', () => {
  const sandbox = '/tmp/sdk-integration-test';

  it('完整对话：文本回复 + 工具调用 + 完成 → 卡片渲染', async () => {
    const session = new SDKSession(sandbox);
    const renderer = new FeishuCardRenderer();

    const events: string[] = [];
    let completed = false;

    const stream = session.start('用 Bash 运行 `echo sdk-test-ok` 然后只回复"测试通过"三个字。', {
      cwd: sandbox,
      maxTurns: 4,
    });

    for await (const event of stream) {
      events.push(event.type);
      renderer.addEvent(event);
      if (event.type === 'completed') completed = true;
    }

    expect(completed).toBe(true);
    expect(events).toContain('init');
    expect(events).toContain('tool_use');
    expect(events).toContain('tool_result');
    expect(events).toContain('completed');
    
    const card = renderer.finalize();
    expect(card.color).toBe('green');
    expect(card.isTerminal).toBe(true);
  }, 120_000); // 120s 超时

  it('会话 resume：第二轮记住第一轮上下文', async () => {
    const session = new SDKSession(sandbox);

    // 第一轮：创建标记文件
    const round1 = session.start('用 Write 创建 /tmp/sdk-integration-test/spike-test-round1.txt，内容写 round1-ok', {
      cwd: sandbox,
      maxTurns: 3,
    });
    for await (const _ of round1) { /* consume */ }

    const sid = session.getSessionId();
    expect(sid).toBeTruthy();

    // 第二轮：resume，问它第一轮做了什么
    const round2 = session.resume(sid!, '我第一轮创建了什么文件？只回文件名。', {
      cwd: sandbox,
      maxTurns: 2,
    });
    let answer = '';
    for await (const event of round2) {
      if (event.type === 'completed') answer = event.text;
    }

    expect(answer).toMatch(/spike-test-round1/i);
  }, 180_000); // 180s（两轮）
});
```

- [ ] **Step 1: 创建集成测试文件**

- [ ] **Step 2: 运行集成测试**

Run: `npx vitest run src/sdk/__tests__/sdk-session.integration.test.ts`
Expected: 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/sdk/__tests__/sdk-session.integration.test.ts
git commit -m "test: 新增 SDKSession 集成测试（对话+resume 端到端）"
```

---

## Phase A 验收标准

- [ ] `npx vitest run src/sdk/__tests__/` 全部通过
- [ ] `SDK_EVENT_MODE=true` 启动 sbot → 飞书消息走 SDK 路径 → 飞书收到正确文本卡片
- [ ] `SDK_EVENT_MODE=false`（或不设）→ 行为完全不变（现有 PTY 路径）
- [ ] `npx tsc --noEmit` 零错误

---

## Phase B：ApprovalGate 上线（审批接入）

### 概述（待阶段 A 完成后细化）

- 创建 `src/sdk/approval-gate.ts`：`ApprovalGate` 类，实现 `onApproval(req: ApprovalRequest): Promise<PermissionResult>`
- 修改 `dispatchToClaudeViaSDK`：将 `onApproval` 从 `return {behavior:'allow'}` 改为 `this.approvalGate.handle(req)`
- `ApprovalGate.handle()` 内：渲染飞书审批卡片（含 displayName + 命令预览 + 允许/拒绝按钮）→ 发飞书消息 → `await` 一个 Promise（通过 `Map<toolUseId, {resolve}>` 等待用户在飞书点击按钮后触发回调 resolve）
- 新增飞书 `card.action.trigger` 回调处理：收到审批卡片按钮事件 → 找到对应的 pending Promise → resolve
- 超时：5 分钟无响应 → 默认 `deny` + 飞书提示
- 单测：超时 deny、用户 allow、用户 deny、并发多个审批请求

---

## Phase C：终端 PTY 接 --resume

### 概述（待阶段 A+B 完成后细化）

- 修改 `index.ts`：启动时若 `SDK_EVENT_MODE=true` + PTY 启用，传 `extraArgs: ['--resume', sessionId]`
- 修改 `PTYManager`：瘦身——去掉 `OutputParser` 引用；`onData` 仅保留 raw 广播，不再调 `parser.parse()`
- 三端一致性集成测试：SDK 创建 session → PTY resume 同 session → 上下文一致

---

## Phase D：废弃旧代码 + 容器化

### 概述（待阶段 A+B+C 完成后细化）

- 删除 `src/pty/output-parser.ts` + 其测试
- 清理 `feishu-bridge.ts` 中仅 PTY 路径使用的代码（`doFinalPatch`、`fallbackPtyText`、`lastTranscriptPath`、`completionHandled`、`firstMessageReceived`、`ptyReady`、`permissionNotified`、`DANGEROUS_PATTERNS` 等）
- 创建 `Dockerfile.sdk`：基于 `node:24-alpine`，仅装 SDK 依赖（无 node-pty），CMD 为 `sbot --web-server`（或类似精简入口）
- systemd 配置更新：sbot-web 服务改用新镜像
