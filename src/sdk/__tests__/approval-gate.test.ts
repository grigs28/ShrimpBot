import { describe, it, expect } from 'vitest';
import { classify } from '../approval-gate.js';

describe('ApprovalGate.classify（等效 bypass，只 AskUserQuestion 转发）', () => {
  it('AskUserQuestion → question', () => {
    expect(classify('AskUserQuestion', { questions: [] })).toBe('question');
  });
  it('Bash 危险 → allow（等效 bypass）', () => {
    expect(classify('Bash', { command: 'rm -rf /' })).toBe('allow');
  });
  it('Write → allow', () => {
    expect(classify('Write', { file_path: '/etc/x' })).toBe('allow');
  });
  it('Read → allow', () => {
    expect(classify('Read', { file_path: 'x' })).toBe('allow');
  });
  it('未知工具 → allow', () => {
    expect(classify('Foo', {})).toBe('allow');
  });
});
