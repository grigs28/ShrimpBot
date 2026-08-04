// Spike 2: canUseTool 异步审批（模拟飞书按钮）+ resume 会话恢复
import { query, listSessions } from '@anthropic-ai/claude-agent-sdk';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,23)}]`, ...a);
const SANDBOX = '/opt/ShrimpBot/.claude/worktrees/sdk-spike/spike-sandbox';
const MODEL = 'glm-5.2';
const to = (ms) => setTimeout(()=>{log('⏰ 全局超时');process.exit(2);},ms);

log('=== Spike 2: canUseTool 异步审批 + resume ===\n');

// ---------- Part A: canUseTool 异步挂起 ----------
log('--- Part A: canUseTool 异步审批（default 模式，模拟飞书按钮 4s 延迟）---');
let approvalLog = [];
let sidA = null;
const globalTo = to(120000);

try {
  const q = query({
    prompt: '用 Bash 运行 `echo approved-test` 然后告诉我结果。只回一句话。',
    options: {
      cwd: SANDBOX, model: MODEL, maxTurns: 4,
      // 关键：用 default 模式才能触发 canUseTool（bypass 不触发）
      permissionMode: 'default',
      // 不预设 allowedTools，强制走审批回调
      canUseTool: async (toolName, input, ctx) => {
        log(`🔔 [canUseTool] 工具=${toolName} 命令=${JSON.stringify(input.command||input).slice(0,50)}`);
        log(`   title="${ctx.title}" displayName="${ctx.displayName}" toolUseID=${ctx.toolUseID?.slice(0,8)} agentID=${ctx.agentID||'无'}`);
        approvalLog.push({toolName, input, title: ctx.title, displayName: ctx.displayName});

        // 模拟"转发飞书卡片 → 等用户点按钮"：异步挂起 4 秒
        log('   ⏳ 模拟转发飞书审批卡片，等待 4s 后用户点"允许"...');
        await new Promise(r => setTimeout(r, 4000));
        log('   ✅ 用户已允许，返回 allow');
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  for await (const msg of q) {
    if (msg.type==='system'&&msg.subtype==='init') sidA = msg.session_id;
    if (msg.type==='assistant') for(const b of msg.message?.content||[]){if(b.type==='text')log(`[text] "${(b.text||'').slice(0,90)}"`);if(b.type==='tool_use')log(`[tool_use] ${b.name}`);}
    if (msg.type==='result'){log(`[result] cost=$${msg.total_cost_usd} subtype=${msg.subtype}`);}
  }
  log(`✅ Part A 完成: 审批触发 ${approvalLog.length} 次，会话挂起正常恢复\n`);

  // ---------- Part B: resume 会话恢复 ----------
  log('--- Part B: resume 恢复会话（让它记住 Part A 的内容）---');
  log(`   恢复 session_id=${sidA?.slice(0,8)}...`);
  let remembered = null;
  const q2 = query({
    prompt: '你上一轮用 Bash 运行了什么命令？只回命令本身，不要解释。',
    options: { cwd: SANDBOX, model: MODEL, maxTurns: 2, resume: sidA,
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
  });
  for await (const msg of q2) {
    if (msg.type==='assistant') for(const b of msg.message?.content||[]) if(b.type==='text'){remembered=b.text;log(`[resume/text] "${(b.text||'').slice(0,90)}"`);}
    if (msg.type==='result') log(`[resume/result] subtype=${msg.subtype}`);
  }
  const ok = remembered && remembered.includes('approved-test');
  log(`\n✅ Part B: resume ${ok?'记住上下文 ✅':'未记住 ⚠️'} (回复="${remembered?.slice(0,60)}")\n`);

  // ---------- Part C: listSessions ----------
  log('--- Part C: listSessions 能否列出会话 ---');
  const sessions = await listSessions({ dir: SANDBOX });
  log(`   找到 ${sessions.length} 个会话`);
  const found = sessions.find(s => s.sessionId === sidA);
  log(`   本次会话在列表中: ${found?'✅':'❌'} (共 ${sessions.length} 个)`);
  if (found) log(`   mtime=${found.mtime} messageCount=${found.messageCount??'?'}`);

  clearTimeout(globalTo);
  log('\n=== Spike 2 总判定 ===');
  const checks = {
    'canUseTool 触发并能异步挂起': approvalLog.length > 0,
    'canUseTool 拿到 title/displayName 等字段': approvalLog.some(a=>a.title||a.displayName),
    '挂起后流程正常恢复': true,
    'resume 恢复上下文': ok,
    'listSessions 列出会话': sessions.length > 0,
  };
  for(const[k,v]of Object.entries(checks)) log(`${v?'✅':'❌'} ${k}`);
  const pass = Object.values(checks).every(Boolean);
  log(`\nSpike 2 总体: ${pass?'✅ 成立':'⚠️ 部分成立'}`);
  process.exit(pass?0:1);
} catch(e){clearTimeout(globalTo);log('❌ 异常:',e.message);log(e.stack?.slice(0,400));process.exit(3);}
