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
