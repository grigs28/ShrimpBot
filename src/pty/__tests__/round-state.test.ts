import { describe, it, expect } from 'vitest';
import { RoundState } from '../round-state.js';

describe('RoundState.observeHookPromptId（prompt_id 轮次识别）', () => {
  it('轮次进行中：新 id 只记录，不触发外部轮次', () => {
    const r = new RoundState();
    expect(r.observeHookPromptId('P1', true)).toBe('recorded');
  });

  it('无轮次 + id 不同 → new-external（cron 等外部发起的轮次）', () => {
    const r = new RoundState();
    expect(r.observeHookPromptId('P2', false)).toBe('new-external');
  });

  it('无轮次 + id 相同（轮次已结束、迟到的同轮 hook）→ same', () => {
    const r = new RoundState();
    expect(r.observeHookPromptId('P1', true)).toBe('recorded');
    expect(r.observeHookPromptId('P1', false)).toBe('same');
  });

  it('无 prompt_id（旧 CLI 降级）→ same，行为退回现状', () => {
    const r = new RoundState();
    expect(r.observeHookPromptId(undefined, true)).toBe('same');
    expect(r.observeHookPromptId(undefined, false)).toBe('same');
  });

  it('轮次进行中 id 缺失不覆盖已记录的 id', () => {
    const r = new RoundState();
    r.observeHookPromptId('P1', true);
    expect(r.observeHookPromptId(undefined, true)).toBe('same');
    // P1 已记录：该轮结束后同 id 迟到 hook 仍判 same
    expect(r.observeHookPromptId('P1', false)).toBe('same');
  });

  it('完整序列：用户轮记录 → 轮末迟到回放 same → cron 轮 new-external → 轮内 recorded', () => {
    const r = new RoundState();
    expect(r.observeHookPromptId('P1', true)).toBe('recorded');    // 用户轮首个 hook（claudeBusy=true）
    expect(r.observeHookPromptId('P1', false)).toBe('same');       // 轮次结束后同轮迟到 hook
    expect(r.observeHookPromptId('P2', false)).toBe('new-external'); // cron 轮（无人发起）
    expect(r.observeHookPromptId('P2', true)).toBe('recorded');    // 该轮后续 hook
    expect(r.observeHookPromptId('P2', false)).toBe('same');       // 该轮结束后的迟到 hook
  });
});
