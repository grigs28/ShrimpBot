// SDKSession：封装 Claude Agent SDK 的 query() / resume()，统一产出 SDKBridgeEvent 流
//
// 设计要点：
// - SDK 的 canUseTool 是普通 async 回调（返回 Promise<PermissionResult | null>），
//   不是 async generator——无法在其中 `yield` 事件。因此采用 push-pull buffer：
//   canUseTool 与 SDK 消息流并发运行，两者都通过 emit() 把事件推入同一队列，
//   由主 generator 统一 yield 给消费者。
// - 消息分发逻辑（system/assistant/user/result）抽到 #convertMessage()，
//   start() 与 resume() 共用，避免重复。
// - 消费者提前 break（return/throw）时，通过 AbortController 中止底层 query，
//   避免后台任务泄漏。

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  SDKMessage,
  SDKResultMessage,
  CanUseTool,
  PermissionResult as SDKPermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKBridgeEvent, ApprovalRequest, PermissionResult } from './sdk-types.js';
import { logger } from '../logger.js';

const TAG = 'SDKSession';

// 始终禁用的高危工具模式（即便 canUseTool 也不会被询问）
const HIGH_RISK_TOOLS: readonly string[] = [
  'Bash(rm *)',
  'Bash(sudo *)',
  'Bash(dd *)',
  'Bash(mkfs *)',
  'Bash(:(){ *)',
  'Bash(shutdown *)',
  'Bash(docker run *)',
];

export interface SDKSessionOptions {
  /** 模型 ID（省略时用 SDK 默认） */
  model?: string;
  /** 权限模式，默认 'default' */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';
  /** 最大轮次，默认 50 */
  maxTurns?: number;
  /** 审批回调：返回 allow/deny。未提供时，canUseTool 直通 allow（由 SDK 处理） */
  onApproval?: (req: ApprovalRequest) => Promise<PermissionResult>;
  /** 审批超时 ms（默认 300000 = 5 分钟）——超时后 AbortSignal 触发 */
  approvalTimeoutMs?: number;
}

export class SDKSession {
  private sessionId: string | null = null;
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** 当前会话 ID（system/init 收到前为 null） */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** 开始新会话，返回事件流 */
  async *start(prompt: string, options: SDKSessionOptions = {}): AsyncGenerator<SDKBridgeEvent> {
    yield* this.#run(prompt, options, undefined);
  }

  /** 恢复已有会话。resume 时 system/init 事件可能不发，sessionId 仍会从 result 事件回填 */
  async *resume(sessionId: string, prompt: string, options: SDKSessionOptions = {}): AsyncGenerator<SDKBridgeEvent> {
    // 预置 sessionId，便于消费者在 resume 场景立即读取
    this.sessionId = sessionId;
    yield* this.#run(prompt, options, sessionId);
  }

  /**
   * 统一的 query 执行器。start/resume 共用，差别仅在是否传入 resume sessionId。
   *
   * 并发模型：
   *   - 后台 consume 任务：消费 SDK query() 的消息流，转成 SDKBridgeEvent 后 emit()
   *   - canUseTool 回调：构造 ApprovalRequest，emit approval_request，再 await 用户回调
   *   - 主 generator：从 buffer/waiter 取事件 yield 给消费者
   *   - null 作为哨兵表示 consume 结束
   */
  async *#run(
    prompt: string,
    options: SDKSessionOptions,
    resumeId: string | undefined,
  ): AsyncGenerator<SDKBridgeEvent> {
    const approvalTimeout = options.approvalTimeoutMs ?? 300_000;

    // push-pull 队列：emit 把事件投递给等待中的 waiter，或推入 buffer
    const buffer: (SDKBridgeEvent | null)[] = [];
    let waiter: ((e: SDKBridgeEvent | null) => void) | null = null;

    const emit = (e: SDKBridgeEvent | null): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(e);
      } else {
        buffer.push(e);
      }
    };

    // 构造 canUseTool：仅在调用者提供 onApproval 时启用
    const canUseTool: CanUseTool | undefined = options.onApproval
      ? async (toolName, input, ctx): Promise<SDKPermissionResult> => {
          // 组合 SDK 中断信号 + 超时信号：任一触发都让 req.signal 被 abort
          const signal = AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(approvalTimeout),
          ]);
          const req: ApprovalRequest = {
            toolName,
            toolUseId: ctx.toolUseID,
            input,
            displayName: ctx.displayName,
            title: ctx.title,
            description: ctx.description,
            agentId: ctx.agentID,
            signal,
          };
          // 先把请求事件投递给消费者（用于 UI 显示）
          emit({ type: 'approval_request', request: req });
          try {
            const result = await options.onApproval!(req);
            if (result.behavior === 'deny') {
              return { behavior: 'deny' as const, message: result.message ?? '用户拒绝' };
            }
            return { behavior: 'allow' as const, updatedInput: result.updatedInput };
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            logger.error(TAG, `审批回调异常: ${detail}`);
            return { behavior: 'deny' as const, message: '审批处理异常，默认拒绝' };
          }
        }
      : undefined;

    // AbortController：消费者提前离开时中止底层 query
    const abortController = new AbortController();

    const queryOptions: Options = {
      cwd: this.cwd,
      model: options.model,
      permissionMode: options.permissionMode ?? 'default',
      maxTurns: options.maxTurns ?? 50,
      disallowedTools: [...HIGH_RISK_TOOLS],
      canUseTool,
      abortController,
    };
    if (resumeId !== undefined) {
      queryOptions.resume = resumeId;
    }

    // 后台消费 SDK 消息流（IIFE 立即启动）
    const consume = (async (): Promise<void> => {
      const label = resumeId ? 'resume' : 'query';
      try {
        const q = query({ prompt, options: queryOptions });
        for await (const msg of q) {
          for (const e of this.#convertMessage(msg)) {
            emit(e);
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(TAG, `${label} 异常: ${detail}`);
        emit({
          type: 'error',
          message: resumeId ? `会话恢复失败: ${detail}` : detail,
          detail: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
        });
      } finally {
        // 哨兵：通知主 generator 结束
        emit(null);
      }
    })();

    try {
      while (true) {
        let next: SDKBridgeEvent | null;
        if (buffer.length > 0) {
          next = buffer.shift() ?? null;
        } else {
          next = await new Promise<SDKBridgeEvent | null>((resolve) => {
            waiter = resolve;
          });
        }
        if (next === null) break; // consume 完成
        yield next;
      }
    } finally {
      // 消费者提前 return/throw：中止底层 query，并等 consume 收尾
      abortController.abort();
      await consume.catch(() => {
        // consume 抛错已通过 emit error 处理；这里吞掉 promise rejection
      });
    }
  }

  /**
   * 把单条 SDKMessage 转为零或多个 SDKBridgeEvent。
   * 仅处理桥需要转发的类型（system/init、assistant、user/tool_result、result）；
   * 其他类型（status、partial、control 等）暂不转发。
   */
  #convertMessage(msg: SDKMessage): SDKBridgeEvent[] {
    const events: SDKBridgeEvent[] = [];
    try {
      if (msg.type === 'system') {
        // SDKSystemMessage：subtype === 'init' 时携带 sessionId/model/cwd
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          events.push({
            type: 'init',
            sessionId: msg.session_id,
            model: msg.model,
            cwd: this.cwd,
          });
        }
      } else if (msg.type === 'assistant') {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text', text: block.text, partial: false });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_use',
              toolName: block.name,
              toolUseId: block.id,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      } else if (msg.type === 'user') {
        // SDKUserMessage.message.content 可能是 string 或 ContentBlockParam[]
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'tool_result') {
              events.push({
                type: 'tool_result',
                toolUseId: String(block.tool_use_id ?? ''),
                isError: !!block.is_error,
                content: toolResultContentToString(block.content),
              });
            }
          }
        }
      } else if (msg.type === 'result') {
        events.push(...this.#convertResult(msg));
      }
      // 其余 message 类型（status / partial / control / hook 等）不转发
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(TAG, `消息转换异常: ${detail}`);
    }
    return events;
  }

  #convertResult(msg: SDKResultMessage): SDKBridgeEvent[] {
    if (msg.subtype === 'success') {
      const text = typeof msg.result === 'string' ? msg.result : '';
      // 校验 success 文本是否隐藏认证/限流错误
      const isHiddenError = /API Error|403|usage limit|billing|quota/i.test(text);
      if (isHiddenError) {
        return [{ type: 'error', message: `模型调用失败: ${text.slice(0, 200)}` }];
      }
      return [{
        type: 'completed',
        text,
        cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0,
        turns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
        sessionId: msg.session_id,
      }];
    }
    // error_during_execution / error_max_turns / error_max_budget_usd / error_max_structured_output_retries
    const errors = Array.isArray(msg.errors) ? msg.errors.filter((e): e is string => typeof e === 'string') : [];
    const message = errors.join('; ') || `SDK 返回异常: subtype=${msg.subtype}`;
    return [{ type: 'error', message }];
  }
}

/**
 * SDK user 消息的 tool_result content 可能是 string、ContentBlockParam[] 或其它。
 * 统一转成字符串，便于桥透传到飞书/Web。
 */
function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text ?? '');
        return '';
      })
      .join('');
  }
  return content == null ? '' : String(content);
}
