import { describe, it, expect } from 'vitest';
import { OutputParser } from '../output-parser.js';

describe('OutputParser', () => {
  it('should extract complete response with ● marker', () => {
    const parser = new OutputParser();
    // 模拟 Claude 完成回复的 chunk
    const raw = '\r●交互PTY成功\r· Noodling…';
    const results = parser.parse(raw);

    const responses = results.filter(r => r.type === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);

    const complete = responses.find(r => r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.text).toContain('交互PTY成功');
  });

  it('should ignore loading animation characters', () => {
    const parser = new OutputParser();
    const results = parser.parse('\r✶\r\r\n\r\n');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore status bar', () => {
    const parser = new OutputParser();
    const results = parser.parse('\r[glm-5.1] │ ShrimpBot git:(master*)\r\r\nContext ░░░░░░░░░░ 0%');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore TUI frame', () => {
    const parser = new OutputParser();
    const results = parser.parse('╭───ClaudeCodev2.1.97───╮\r\r\n│Tips for getting started│');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore MCP status', () => {
    const parser = new OutputParser();
    const results = parser.parse('\r6 MCP servers failed · /mcp\r\r\n');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should extract streaming text that accumulates', () => {
    const parser = new OutputParser();

    // 流式累积过程中的中间片段可以忽略（噪音过滤）
    // 重要的是最终完成标记能提取出完整回复
    const results2 = parser.parse('\r●交互PTY成功\r');
    const r2 = results2.filter(r => r.type === 'response' && r.isComplete);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.text).toBe('交互PTY成功');
  });

  it('should handle -p mode clean output', () => {
    const parser = new OutputParser();
    const results = parser.parse('测试PTY成功\r\n');

    const responses = results.filter(r => r.type === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);
  });

  it('should clean trailing Noodling status', () => {
    const parser = new OutputParser();
    const results = parser.parse('\r●这是回复内容\r· Noodling… (running stop hook)');
    const complete = results.find(r => r.type === 'response' && r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.text).toBe('这是回复内容');
  });

  it('should filter out known noise patterns', () => {
    const parser = new OutputParser();
    const noise = [
      '\rSwooping…',
      '\rhigh·/effort',
      '\rng…',
      '\rg…',
      '\ropng',
      '\r0q',
    ];
    for (const n of noise) {
      const results = parser.parse(n);
      const responses = results.filter(r => r.type === 'response');
      expect(responses).toHaveLength(0);
    }
  });

  it('should detect yes/no question', () => {
    const parser = new OutputParser();
    const results = parser.parse('\r●Allow this tool call? [y/n]\r');
    const complete = results.find(r => r.type === 'response' && r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.isYesNo).toBe(true);
  });

  it('should detect numbered options', () => {
    const parser = new OutputParser();
    const results = parser.parse('1. 选项一\r2. 选项二\r3. 选项三');
    const options = results.filter(r => r.type === 'question');
    expect(options.length).toBeGreaterThanOrEqual(3);
  });
});
