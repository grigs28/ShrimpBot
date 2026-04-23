import { describe, it, expect } from 'vitest';
import { OutputParser } from '../output-parser.js';

describe('OutputParser', () => {
  it('should treat ● as streaming start (not complete)', () => {
    const parser = new OutputParser();
    // 使用 \n 而非 \r\n，ghostty-opentui 会正确处理
    // 内容长度需 >= 10（cleanText 后）
    const raw = '●交互PTY测试成功了\n· Noodling…';
    const results = parser.parse(raw);

    const responses = results.filter(r => r.type === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);

    // ● 不再标记完成，只触发流式响应
    const complete = responses.find(r => r.isComplete);
    expect(complete).toBeUndefined();

    const streaming = responses.find(r => !r.isComplete);
    expect(streaming).toBeDefined();
    expect(streaming!.text).toContain('交互PTY测试成功了');
  });

  it('should complete on ❯ input prompt', () => {
    const parser = new OutputParser();
    // 先累积一些内容（长度需 >= 10）
    parser.parse('●这是回复内容测试哦哈\n');
    // 然后出现 ❯ 提示符
    const results = parser.parse('❯ ');

    const complete = results.find(r => r.type === 'response' && r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.text).toContain('这是回复内容测试哦哈');
  });

  it('should ignore loading animation characters', () => {
    const parser = new OutputParser();
    const results = parser.parse('✶\n\n');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore status bar', () => {
    const parser = new OutputParser();
    const results = parser.parse('[glm-5.1] │ ShrimpBot git:(master*)\nContext ░░░░░░░░░░ 0%');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore TUI frame', () => {
    const parser = new OutputParser();
    const results = parser.parse('╭───ClaudeCodev2.1.97───╮\n│Tips for getting started│');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should ignore MCP status', () => {
    const parser = new OutputParser();
    const results = parser.parse('6 MCP servers failed · /mcp\n');
    const responses = results.filter(r => r.type === 'response');
    expect(responses).toHaveLength(0);
  });

  it('should accumulate streaming text across multiple chunks', () => {
    const parser = new OutputParser();

    // 第一块：● 开始（长度需 >= 10）
    const r1 = parser.parse('●第一部分测试内容哦哈\n');
    expect(r1.some(r => r.type === 'response' && !r.isComplete && r.text.includes('第一部分测试内容哦哈'))).toBe(true);

    // 第二块：继续累积
    const r2 = parser.parse('第二部分测试内容哈哦\n');
    expect(r2.some(r => r.type === 'response' && !r.isComplete && r.text.includes('第一部分测试内容哦哈') && r.text.includes('第二部分测试内容哈哦'))).toBe(true);

    // 第三块：❯ 完成
    const r3 = parser.parse('❯ ');
    const complete = r3.find(r => r.type === 'response' && r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.text).toContain('第一部分测试内容哦哈');
    expect(complete!.text).toContain('第二部分测试内容哈哦');
  });

  it('should handle -p mode clean output', () => {
    const parser = new OutputParser();
    const results = parser.parse('测试PTY成功\n');

    const responses = results.filter(r => r.type === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);
  });

  it('should clean trailing Noodling status', () => {
    const parser = new OutputParser();
    const results = parser.parse('●这是回复内容测试哦哈\n· Noodling… (running stop hook)');
    const streaming = results.find(r => r.type === 'response' && !r.isComplete);
    expect(streaming).toBeDefined();
    expect(streaming!.text).toBe('这是回复内容测试哦哈');
  });

  it('should filter out known noise patterns', () => {
    const parser = new OutputParser();
    const noise = [
      'Swooping…',
      'high·/effort',
      'ng…',
      'g…',
      'opng',
      '0q',
    ];
    for (const n of noise) {
      const results = parser.parse(n);
      const responses = results.filter(r => r.type === 'response');
      expect(responses).toHaveLength(0);
    }
  });

  it('should detect yes/no question text', () => {
    const parser = new OutputParser();
    const results = parser.parse('●Allow this tool call? Please confirm [y/n]\n');
    const streaming = results.find(r => r.type === 'response' && !r.isComplete);
    expect(streaming).toBeDefined();
    expect(streaming!.text).toContain('Allow this tool call?');
  });

  it('should detect numbered options as text', () => {
    const parser = new OutputParser();
    const results = parser.parse('1. 选项一\n2. 选项二\n3. 选项三');
    const responses = results.filter(r => r.type === 'response');
    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(responses[0]!.text).toContain('1. 选项一');
  });

  it('should handle table content and flush on ❯', () => {
    const parser = new OutputParser();
    // 标题（长度需 >= 10）
    parser.parse('●当前已安装的 MCP 服务器列表\n');
    // 表格边框和内容
    parser.parse('┌──────┬──────┐\n');
    parser.parse('│ 名称 │ 类型 │\n');
    parser.parse('├──────┼──────┤\n');
    parser.parse('│ ctx7 │ 文档 │\n');
    parser.parse('└──────┴──────┘\n');
    // ❯ 完成
    const results = parser.parse('❯ ');

    const complete = results.find(r => r.type === 'response' && r.isComplete);
    expect(complete).toBeDefined();
    expect(complete!.text).toContain('当前已安装的 MCP 服务器列表');
    expect(complete!.text).toContain('| 名称 | 类型 |');
    expect(complete!.text).toContain('| ctx7 | 文档 |');
  });
});
