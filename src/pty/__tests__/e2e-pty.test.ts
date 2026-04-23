// 端到端测试：PTY + 解析器 提取 Claude 回复
import { spawn } from 'node-pty';
import { OutputParser } from '../output-parser.js';

const pty = spawn('/home/grigs/.local/bin/claude', ['--dangerously-skip-permissions'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  env: process.env as Record<string, string>,
});

const parser = new OutputParser();
let sent = false;
let gotResponse = false;

pty.onData((data) => {
  // 写入 headless 终端
  parser.write(data);

  const results = parser.parse('');
  for (const r of results) {
    if (r.type === 'response') {
      console.error(`[RESPONSE isComplete=${r.isComplete}] ${r.text.slice(0, 100)}`);
      if (r.isComplete && r.text.includes('PTY')) {
        gotResponse = true;
        console.error('\n=== SUCCESS ===');
        console.error(`Extracted: "${r.text}"`);
        pty.kill();
        process.exit(0);
      }
    }
  }

  // 发送消息
  if (!sent) {
    sent = true;
    setTimeout(() => {
      console.error('>>> Sending message <<<');
      pty.write('只回复"PTY端到端测试成功"，不要其他内容\r');
    }, 5000);
  }
});

pty.onExit(({ exitCode }) => {
  if (!gotResponse) {
    console.error(`FAILED: exited without response (code=${exitCode})`);
  }
  process.exit(gotResponse ? 0 : 1);
});

setTimeout(() => {
  console.error('TIMEOUT');
  pty.kill();
  process.exit(1);
}, 60000);
