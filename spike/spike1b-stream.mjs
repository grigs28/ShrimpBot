// Spike 1b: 改用 glm-5.2 重跑 stream 验证（K3 额度用尽）
import { query } from '@anthropic-ai/claude-agent-sdk';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,23)}]`, ...a);
const SANDBOX = '/opt/ShrimpBot/.claude/worktrees/sdk-spike/spike-sandbox';

log('=== Spike 1b: stream 事件 (glm-5.2) ===');
const seen = { init:0, assistant:0, toolUse:0, toolResult:0, result:0 };
let sessionId=null, finalText=null, cost=null;
const toolNames = new Set();
const to = setTimeout(()=>{log('⏰ 超时');process.exit(2);},90000);

try {
  const q = query({
    prompt: '用 Bash 运行 `echo hello-$(date +%s)` 然后告诉我输出是什么。只回复一句话。',
    options: {
      cwd: SANDBOX,
      model: 'glm-5.2',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 4,
    },
  });
  for await (const msg of q) {
    if (msg.type==='system'&&msg.subtype==='init'){seen.init++;sessionId=msg.session_id;log(`[init] sid=${sessionId?.slice(0,8)} tools=${(msg.tools||[]).length}`);}
    else if (msg.type==='assistant'){seen.assistant++;for(const b of msg.message?.content||[]){if(b.type==='text')log(`[text] "${(b.text||'').slice(0,90)}"`);if(b.type==='tool_use'){seen.toolUse++;toolNames.add(b.name);log(`[tool_use] ${b.name}: ${JSON.stringify(b.input).slice(0,70)}`);}}}
    else if (msg.type==='user'){for(const b of msg.message?.content||[])if(b.type==='tool_result'){seen.toolResult++;log(`[tool_result] err=${b.is_error} content="${String(b.content).slice(0,70)}"`);}}
    else if (msg.type==='result'){seen.result++;finalText=msg.result;cost=msg.total_cost_usd;sessionId=msg.session_id||sessionId;log(`[result] cost=$${cost} turns=${msg.num_turns} dur=${msg.duration_ms}ms subtype=${msg.subtype}`);}
  }
  clearTimeout(to);
  log('\n=== 汇总 ==='); log('计数',JSON.stringify(seen)); log('工具',[...toolNames].join(',')); log('sid',sessionId); log('最终',finalText?`"${finalText.slice(0,100)}"`:'(无)'); log('cost',cost);
  const c={sid:!!sessionId,text:seen.assistant>0,toolUse:seen.toolUse>0,toolResult:seen.toolResult>0,result:seen.result>0,cost:cost!=null};
  log('\n=== 判定 ==='); for(const[k,v]of Object.entries(c))log(`${v?'✅':'❌'} ${k}`);
  const pass=Object.values(c).every(Boolean); log(`\nSpike 1b 总体: ${pass?'✅ 成立':'⚠️ 部分成立'}`);
  process.exit(pass?0:1);
} catch(e){clearTimeout(to);log('❌ 异常:',e.message);process.exit(3);}
