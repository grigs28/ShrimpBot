// Spike 2b: 最小化强制触发 canUseTool
// 用 acceptEdits 模式跑只读命令不触发；改用显式 default + disallowedTools 外的方式。
// 关键：文档说 canUseTool 只在"权限流 fall through 到 prompt"时触发。
// 用一个不被任何 allow 规则覆盖的写操作（Write 工具）在 default 模式下强制 prompt。
import { query } from '@anthropic-ai/claude-agent-sdk';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,23)}]`, ...a);
const CLEAN = '/tmp/spike-clean';
const MODEL = 'glm-5.2';
const to = setTimeout(()=>{log('⏰ 超时');process.exit(2);},120000);

log('=== Spike 2b: 强制触发 canUseTool（default 模式 + Write 工具）===');
log(`cwd=${CLEAN}（干净目录，无 .claude 继承）`);
let calls = 0;
let captured = {};

try {
  const q = query({
    prompt: '用 Write 工具创建一个文件 /tmp/spike-clean/test.txt，内容写 "hello"。完成后只回复"已创建"三个字。',
    options: {
      cwd: CLEAN, model: MODEL, maxTurns: 4,
      permissionMode: 'default',
      // 显式不预批准任何工具
      canUseTool: async (toolName, input, ctx) => {
        calls++;
        captured = { toolName, input, title: ctx.title, displayName: ctx.displayName,
                     toolUseID: ctx.toolUseID, decisionReason: ctx.decisionReason };
        log(`\n🔔 [canUseTool 触发 #${calls}]`);
        log(`   toolName=${toolName}`);
        log(`   input=${JSON.stringify(input).slice(0,120)}`);
        log(`   title="${ctx.title||''}"`);
        log(`   displayName="${ctx.displayName||''}"`);
        log(`   decisionReason="${ctx.decisionReason||''}"`);
        log(`   toolUseID=${ctx.toolUseID?.slice(0,12)} agentID=${ctx.agentID||'主会话'}`);
        log(`   blockedPath="${ctx.blockedPath||''}"`);
        log(`   ⏳ 异步挂起 3s（模拟飞书审批等待）...`);
        await new Promise(r=>setTimeout(r,3000));
        log(`   ✅ 返回 allow（用户点了"允许"）`);
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  for await (const msg of q) {
    if (msg.type==='assistant') for(const b of msg.message?.content||[]){
      if(b.type==='text')log(`[text] "${(b.text||'').slice(0,80)}"`);
      if(b.type==='tool_use')log(`[tool_use] ${b.name}`);
    }
    if (msg.type==='result') log(`[result] subtype=${msg.subtype} cost=$${msg.total_cost_usd}`);
  }
  clearTimeout(to);
  const fileCreated = require('fs').existsSync('/tmp/spike-clean/test.txt');
  log(`\n文件实际创建: ${fileCreated?'✅':'❌'}（验证 allow 决策真的被执行）`);

  log('\n=== Spike 2b 判定 ===');
  const c = {
    'canUseTool 被触发': calls > 0,
    '拿到 title 字段': !!captured.title,
    '拿到 displayName 字段': !!captured.displayName,
    '能异步挂起等待外部输入': calls > 0,  // 3s 挂起后恢复即证明
    'allow 决策被执行(文件创建)': fileCreated,
  };
  for(const[k,v]of Object.entries(c)) log(`${v?'✅':'❌'} ${k}`);
  const pass = Object.values(c).every(Boolean);
  log(`\nSpike 2b 总体: ${pass?'✅ 成立':'⚠️ 部分成立'}`);
  process.exit(pass?0:1);
} catch(e){clearTimeout(to);log('❌ 异常:',e.message);log(e.stack?.slice(0,400));process.exit(3);}
