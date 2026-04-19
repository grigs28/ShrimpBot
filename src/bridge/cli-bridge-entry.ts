import { CLIBridge } from './cli-bridge.js';

const args = process.argv.slice(2);

function getArgValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main() {
  const chatId = getArgValue('--chat');
  const pickMode = args.includes('--pick');
  const apiUrl = getArgValue('--api') || 'http://localhost:9100';
  const botName = getArgValue('--bot') || 'shrimpbot';
  const apiSecret = getArgValue('--secret') || process.env.SHRIMPBOT_API_SECRET;
  const workingDirectory = getArgValue('--cwd');

  if (pickMode && !chatId) {
    // Fetch available chats from API
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiSecret) headers['Authorization'] = `Bearer ${apiSecret}`;
    const resp = await fetch(`${apiUrl}/bridge/chats`, { headers });
    const data = await resp.json() as { chats: Array<{ botName: string; chatId: string; label: string }> };

    if (!data.chats || data.chats.length === 0) {
      console.error('没有找到可用的飞书聊天。确保 ShrimpBot 正在运行且有 Feishu bot 配置。');
      process.exit(1);
    }

    console.log('可用的飞书聊天：');
    for (let i = 0; i < data.chats.length; i++) {
      console.log(`  ${i + 1}. ${data.chats[i].label}`);
    }
    console.log('');

    // Read selection from stdin
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
    const answer: string = await new Promise((resolve) => {
      rl.question('请输入 chatId: ', resolve);
    });
    rl.close();

    const selectedChatId = answer.trim();
    if (!selectedChatId) {
      console.error('未选择聊天');
      process.exit(1);
    }

    const bridge = new CLIBridge({
      chatId: selectedChatId,
      botName,
      apiUrl,
      apiSecret,
      workingDirectory,
    });

    process.on('SIGINT', async () => { await bridge.cleanup(); process.exit(0); });
    process.on('SIGTERM', async () => { await bridge.cleanup(); process.exit(0); });

    await bridge.start();
    return;
  }

  if (!chatId) {
    console.error('用法：shrimpbot-bridge --chat <chatId> 或 shrimpbot-bridge --pick');
    console.error('');
    console.error('选项：');
    console.error('  --chat <chatId>    飞书 chatId');
    console.error('  --pick             交互选择聊天');
    console.error('  --api <url>        ShrimpBot API 地址（默认 http://localhost:9100）');
    console.error('  --bot <name>       机器人名称（默认 shrimpbot）');
    console.error('  --secret <token>   API 密钥（或设置 SHRIMPBOT_API_SECRET）');
    console.error('  --cwd <dir>        Claude Code 工作目录');
    process.exit(1);
  }

  const bridge = new CLIBridge({
    chatId,
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
