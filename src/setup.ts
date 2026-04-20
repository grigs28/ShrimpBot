// src/setup.ts — 首次启动交互式配置向导

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import type { BridgeConfig } from './pty/feishu-bridge.js';

interface BotEntry {
  name: string;
  appId: string;
  appSecret: string;
}

const BOTS_PATH = path.join(os.homedir(), '.shrimpbot', 'bots.json');

function loadBots(): BotEntry[] {
  if (!fs.existsSync(BOTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(BOTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveBots(bots: BotEntry[]): void {
  const dir = path.dirname(BOTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
}

function tryReadFromMcpJson(): BotEntry[] {
  const mcpPath = path.join(os.homedir(), '.claude', '.mcp.json');
  if (!fs.existsSync(mcpPath)) return [];

  try {
    const cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    const servers = cfg.mcpServers || {};
    const bots: BotEntry[] = [];

    for (const [, server] of Object.entries(servers as Record<string, any>)) {
      const env = server.env || {};
      if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
        bots.push({
          name: env.FEISHU_BOT_NAME || env.FEISHU_APP_ID,
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
        });
      }
    }
    return bots;
  } catch {
    return [];
  }
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function selectBot(rl: readline.Interface): Promise<BotEntry> {
  let bots = loadBots();

  // 合并 ~/.claude/.mcp.json 中的凭证
  const mcpBots = tryReadFromMcpJson();
  for (const b of mcpBots) {
    if (!bots.find(x => x.appId === b.appId)) {
      bots.push(b);
    }
  }

  if (bots.length >= 1) {
    console.log('\n🦐 已注册的机器人：');
    bots.forEach((b, i) => console.log(`  ${i + 1}. ${b.name} (${b.appId})`));
    console.log(`  0. 添加新机器人`);

    const choice = await ask(rl, '\n选择编号：');
    const idx = parseInt(choice.trim(), 10);

    if (idx >= 1 && idx <= bots.length) {
      return bots[idx - 1]!;
    }
  }

  // 添加新机器人
  console.log('\n🦐 添加新机器人：');
  const name = await ask(rl, '  名称：');
  const appId = await ask(rl, '  App ID：');
  const appSecret = await ask(rl, '  App Secret：');

  const newBot: BotEntry = { name, appId, appSecret };
  bots.push(newBot);
  saveBots(bots);
  console.log(`  已保存到 ${BOTS_PATH}`);

  return newBot;
}

async function selectChats(
  rl: readline.Interface,
  client: lark.Client,
): Promise<string[]> {
  console.log('\n📡 获取飞书会话列表...');

  const chats: Array<{ chatId: string; name: string }> = [];
  try {
    const resp = await client.im.v1.chat.list({ params: { page_size: 50 } });
    if (resp.data?.items) {
      for (const item of resp.data.items) {
        chats.push({ chatId: item.chat_id!, name: item.name || '(未命名)' });
      }
    }
  } catch (err: any) {
    console.error(`  获取失败: ${err.message}`);
  }

  if (chats.length === 0) {
    const chatId = await ask(rl, '\n  请手动输入 Chat ID：');
    return [chatId];
  }

  console.log('\n📋 飞书会话：');
  chats.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  (${c.chatId})`));

  const choice = await ask(rl, '\n选择编号（多个用逗号分隔）：');
  return choice
    .split(',')
    .map(s => {
      const idx = parseInt(s.trim(), 10) - 1;
      return chats[idx]?.chatId;
    })
    .filter(Boolean) as string[];
}

function saveEnvFile(bot: BotEntry, chatIds: string[]): void {
  const lines = [
    'FEISHU_MODE=bridge',
    `FEISHU_APP_ID=${bot.appId}`,
    `FEISHU_APP_SECRET=${bot.appSecret}`,
    `FEISHU_CHAT_IDS=${chatIds.join(',')}`,
    `FEISHU_BOT_NAME=${bot.name}`,
  ];

  const envPath = path.join(process.cwd(), '.env');
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  console.log(`\n✅ 已保存到 ${envPath}`);
}

/**
 * 交互式配置向导，返回 BridgeConfig
 */
export async function setupWizard(): Promise<BridgeConfig> {
  console.log('🦐 ShrimpBot Bridge — 首次配置\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 1. 选择机器人
    const bot = await selectBot(rl);

    // 2. 获取会话列表并选择
    const client = new lark.Client({
      appId: bot.appId,
      appSecret: bot.appSecret,
      disableTokenCache: false,
    });

    const chatIds = await selectChats(rl, client);

    if (chatIds.length === 0) {
      console.error('❌ 未选择任何会话');
      process.exit(1);
    }

    // 3. 保存到 .env
    saveEnvFile(bot, chatIds);

    // 4. 写入环境变量（当前进程使用）
    process.env.FEISHU_APP_ID = bot.appId;
    process.env.FEISHU_APP_SECRET = bot.appSecret;
    process.env.FEISHU_CHAT_IDS = chatIds.join(',');
    process.env.FEISHU_BOT_NAME = bot.name;

    console.log('\n🚀 配置完成，正在启动 Bridge...\n');

    return {
      feishuAppId: bot.appId,
      feishuAppSecret: bot.appSecret,
      chatIds,
      allowedUsers: [],
    };
  } finally {
    rl.close();
  }
}
