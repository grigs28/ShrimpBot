import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync } from 'node:fs';
import { SDKSession } from '../sdk-session.js';
import { FeishuCardRenderer } from '../feishu-card-renderer.js';

// 集成测试需真实的认证环境，不可用时跳过
const hasAuth = !!process.env.ANTHROPIC_AUTH_TOKEN || !!process.env.ANTHROPIC_BASE_URL;
const describeIf = hasAuth ? describe : describe.skip;

describeIf('SDKSession 集成测试', () => {
  const sandbox = '/tmp/sdk-integration-test';

  // 确保沙箱目录存在（SDK query 以此为 cwd）
  beforeAll(() => {
    mkdirSync(sandbox, { recursive: true });
  });

  it('完整对话：文本回复 + 工具调用 + 完成 → 卡片渲染', async () => {
    const session = new SDKSession(sandbox);
    const renderer = new FeishuCardRenderer();

    const events: string[] = [];
    let completed = false;

    const stream = session.start('用 Bash 运行 `echo sdk-test-ok` 然后只回复"测试通过"三个字。', {
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
    // Write 工具需权限：提供 always-allow 的 onApproval（此用例聚焦 resume 上下文保持，
    // 非权限流程本身）。同时顺带验证 SDKSession 的 canUseTool 集成路径。
    const allowAll = async () => ({ behavior: 'allow' as const });

    // 第一轮：创建标记文件（maxTurns 留足余量：mkdir+Write+确认 通常 3 轮，模型偶发多轮）
    const round1 = session.start('用 Write 创建 /tmp/sdk-integration-test/spike-test-round1.txt，内容写 round1-ok', {
      maxTurns: 6,
      onApproval: allowAll,
    });
    for await (const _ of round1) { /* consume */ }

    const sid = session.getSessionId();
    expect(sid).toBeTruthy();

    // 第二轮：resume，问它第一轮做了什么
    const round2 = session.resume(sid!, '我第一轮创建了什么文件？只回文件名。', {
      maxTurns: 3,
      onApproval: allowAll,
    });
    let answer = '';
    for await (const event of round2) {
      if (event.type === 'completed') answer = event.text;
    }

    expect(answer).toMatch(/spike-test-round1/i);
  }, 180_000); // 180s（两轮）
});
