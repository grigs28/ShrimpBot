// Spike 1: SDK stream 事件是否足够驱动飞书卡片（不解析终端文本）
// 同时验证：无 TTY 环境下 SDK 能否正常工作（本脚本由 node 直接跑，stdin 非 TTY）
import { query } from '@anthropic-ai/claude-agent-sdk';

const SANDBOX = '/opt/ShrimpBot/.claude/worktrees/sdk-spike/spike-sandbox';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

log('=== Spike 1: stream 事件 + 无TTY ===');
log('stdin.isTTY =', process.stdin.isTTY, '(undefined/false 即无 TTY)');

const seen = { init: 0, assistant: 0, textDelta: 0, toolUse: 0, toolResult: 0, result: 0 };
let sessionId = null;
let finalText = null;
let cost = null;
const toolNames = new Set();

const timeout = setTimeout(() => { log('⏰ 90s 超时强制退出'); process.exit(2); }, 90000);

try {
  const q = query({
    prompt: '用 Bash 跑 `ls -la` 看看当前目录，然后用一句话告诉我有几个条目。',
    options: {
      cwd: SANDBOX,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 4,
    },
  });

  for await (const msg of q) {
    const t = msg.type;
    if (t === 'system' && msg.subtype === 'init') {
      seen.init++;
      sessionId = msg.session_id;
      log(`[system/init] session_id=${sessionId} model=${msg.model} tools=${(msg.tools||[]).length}个`);
    } else if (t === 'assistant') {
      seen.assistant++;
      const blocks = msg.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'text') log(`[assistant/text] "${(b.text||'').slice(0,80)}"`);
        if (b.type === 'tool_use') { seen.toolUse++; toolNames.add(b.name); log(`[assistant/tool_use] ${b.name} input=${JSON.stringify(b.input).slice(0,80)}`); }
      }
      if (msg.message?.usage) log(`[assistant/usage] in=${msg.message.usage.input_tokens} out=${msg.message.usage.output_tokens}`);
    } else if (t === 'stream_event') {
      const d = msg.event?.delta;
      if (d?.type === 'text_delta') { seen.textDelta++; }
    } else if (t === 'user') {
      const blocks = msg.message?.content || [];
      for (const b of blocks) if (b.type === 'tool_result') { seen.toolResult++; log(`[user/tool_result] is_error=${b.is_error} len=${String(b.content).length}`); }
    } else if (t === 'result') {
      seen.result++;
      finalText = msg.result;
      cost = msg.total_cost_usd;
      sessionId = msg.session_id || sessionId;
      log(`[result] subtype=${msg.subtype} cost=$${cost} turns=${msg.num_turns} duration=${msg.duration_ms}ms`);
      log(`[result/text] "${(finalText||'').slice(0,120)}"`);
    }
  }

  clearTimeout(timeout);
  log('\n=== Spike 1 结果汇总 ===');
  log('事件计数:', JSON.stringify(seen));
  log('工具调用:', [...toolNames].join(','));
  log('session_id:', sessionId);
  log('最终文本:', finalText ? `"${finalText.slice(0,100)}"` : '(无)');
  log('成本:', cost);

  const checks = {
    '拿到 session_id': !!sessionId,
    '拿到 assistant text': seen.assistant > 0,
    '拿到 tool_use 事件': seen.toolUse > 0,
    '拿到 tool_result 事件': seen.toolResult > 0,
    '拿到最终 result': seen.result > 0,
    '拿到 cost': cost !== null && cost !== undefined,
    '无TTY下运行成功': true,
  };
  log('\n=== 判定 ===');
  for (const [k, v] of Object.entries(checks)) log(`${v ? '✅' : '❌'} ${k}`);
  const pass = Object.values(checks).every(Boolean);
  log(`\nSpike 1 总体: ${pass ? '✅ 成立' : '⚠️ 部分成立'}`);
  process.exit(pass ? 0 : 1);
} catch (err) {
  clearTimeout(timeout);
  log('❌ 异常:', err.message);
  log(err.stack?.slice(0, 500));
  process.exit(3);
}
