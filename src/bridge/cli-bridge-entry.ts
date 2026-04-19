import { CLIBridge } from './cli-bridge.js';

const args = process.argv.slice(2);

function getArgValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

interface ChatInfo {
  chatId: string;
  chatType?: string;
  userId?: string;
  userName?: string;
  lastActivity?: number;
  label?: string;
}

async function pickChat(apiUrl: string, apiSecret?: string): Promise<string | undefined> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiSecret) headers['Authorization'] = `Bearer ${apiSecret}`;

  let chats: ChatInfo[];
  try {
    const resp = await fetch(`${apiUrl}/bridge/chats`, { headers });
    const data = await resp.json() as { chats: ChatInfo[] };
    chats = data.chats || [];
  } catch {
    console.error('无法连接 ShrimpBot API，确认服务是否运行');
    return undefined;
  }

  if (chats.length === 0) {
    console.error('没有找到已知聊天。先在飞书给机器人发条消息，chatId 会自动记录。');
    return undefined;
  }

  console.log('');
  console.log('\x1b[36m╭─────────────────────────────────╮\x1b[0m');
  console.log('\x1b[36m│\x1b[0m  \x1b[1m选择飞书聊天\x1b[0m                    \x1b[36m│\x1b[0m');
  console.log('\x1b[36m╰─────────────────────────────────╯\x1b[0m');

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    const label = chat.label || chat.userName || chat.userId || chat.chatId;
    const type = chat.chatType === 'p2p' ? '💬 私聊' : '👥 群聊';
    const time = chat.lastActivity
      ? new Date(chat.lastActivity).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    console.log(`  \x1b[33m${i + 1}.\x1b[0m ${label}  ${type}  \x1b[90m${time}\x1b[0m`);
    console.log(`     \x1b[90m${chat.chatId}\x1b[0m`);
  }

  console.log('');

  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question('\x1b[32m输入序号或 chatId: \x1b[0m', resolve);
  });
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) return undefined;

  // Check if it's a number (selection by index)
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= chats.length) {
    return chats[num - 1]!.chatId;
  }

  // Otherwise treat as chatId
  return trimmed;
}

async function main() {
  const chatId = getArgValue('--chat');
  const pickMode = args.includes('--pick') || (!chatId && !args.includes('--help'));
  const apiUrl = getArgValue('--api') || 'http://localhost:9100';
  const botName = getArgValue('--bot') || 'shrimpbot';
  const apiSecret = getArgValue('--secret') || process.env.SHRIMPBOT_API_SECRET;
  const workingDirectory = getArgValue('--cwd');

  if (args.includes('--help') || args.includes('-h')) {
    console.log('');
    console.log('\x1b[1mshrimpbot-bridge\x1b[0m — PTY Bridge for Claude Code ↔ Feishu');
    console.log('');
    console.log('  \x1b[33mshrimpbot-bridge\x1b[0m                    \x1b[90m交互选择聊天\x1b[0m');
    console.log('  \x1b[33mshrimpbot-bridge --pick\x1b[0m            \x1b[90m交互选择聊天\x1b[0m');
    console.log('  \x1b[33mshrimpbot-bridge --chat <chatId>\x1b[0m    \x1b[90m直接指定聊天\x1b[0m');
    console.log('');
    console.log('选项：');
    console.log('  --chat <chatId>    飞书 chatId');
    console.log('  --pick             交互选择聊天（默认）');
    console.log('  --api <url>        API 地址（默认 http://localhost:9100）');
    console.log('  --bot <name>       机器人名称（默认 shrimpbot）');
    console.log('  --secret <token>   API 密钥');
    console.log('  --cwd <dir>        Claude Code 工作目录');
    console.log('  --help             显示帮助');
    console.log('');
    process.exit(0);
  }

  // Determine chatId
  let resolvedChatId = chatId;
  if (!resolvedChatId) {
    resolvedChatId = (await pickChat(apiUrl, apiSecret)) || '';
    if (!resolvedChatId) {
      console.error('未选择聊天');
      process.exit(1);
    }
    console.log(`\x1b[32m已选择: ${resolvedChatId}\x1b[0m\n`);
  }

  const bridge = new CLIBridge({
    chatId: resolvedChatId,
    botName,
    apiUrl,
    apiSecret,
    workingDirectory,
  });

  process.on('SIGINT', async () => { await bridge.cleanup(); process.exit(0); });
  process.on('SIGTERM', async () => { await bridge.cleanup(); process.exit(0); });

  await bridge.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
