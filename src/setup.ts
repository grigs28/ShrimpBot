// src/setup.ts — 首次启动交互式配置向导

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadBotsRegistry, saveBotsRegistry, saveShrimpBotConfig, loadShrimpBotConfig } from './config.js';
import type { BridgeConfig } from './pty/feishu-bridge.js';

interface BotEntry {
  name: string;
  appId: string;
  appSecret: string;
  chatIds?: string[];
}

const BOTS_PATH = path.join(os.homedir(), '.shrimpbot', 'bots.json');

function loadBots(): BotEntry[] {
  return loadBotsRegistry();
}

function saveBots(bots: BotEntry[]): void {
  saveBotsRegistry(bots);
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
  return new Promise(resolve => {
    rl.question(question, (answer: string) => {
      resolve(answer);
    });
    rl.on('close', () => {
      resolve('');
    });
  });
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
    const chatId = await ask(rl, '\n  Chat ID（留空跳过，启动后自动发现）：');
    return chatId.trim() ? [chatId.trim()] : [];
  }

  console.log('\n📋 飞书会话：');
  chats.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  (${c.chatId})`));

  const choice = await ask(rl, '\n选择编号（多个用逗号分隔，留空跳过）：');
  if (!choice.trim()) return [];
  return choice
    .split(',')
    .map(s => {
      const idx = parseInt(s.trim(), 10) - 1;
      return chats[idx]?.chatId;
    })
    .filter(Boolean) as string[];
}

function saveShrimpBotState(bot: BotEntry, chatIds: string[]): void {
  // chatIds 写入 bots.json 对应 bot entry
  const bots = loadBots();
  const entry = bots.find(b => b.appId === bot.appId);
  if (entry) {
    entry.chatIds = chatIds;
    saveBots(bots);
  }

  // config.json 只存 activeBotName + claudeCwd
  saveShrimpBotConfig({
    activeBotName: bot.name,
    claudeCwd: process.cwd(),
  });
  console.log(`\n✅ 已保存到 ~/.shrimpbot/`);

  // 写入/更新本地 .sbot（项目级配置，含 FEISHU_BOT_NAME）
  const sbotPath = path.join(process.cwd(), '.sbot');
  let lines: string[] = [];
  if (fs.existsSync(sbotPath)) {
    lines = fs.readFileSync(sbotPath, 'utf-8').split('\n').filter(l => !l.startsWith('FEISHU_BOT_NAME=') && l.trim());
  }
  if (!lines.includes('FEISHU_MODE=bridge')) {
    lines.push('FEISHU_MODE=bridge');
  }
  lines.push(`FEISHU_BOT_NAME=${bot.name}`);
  fs.writeFileSync(sbotPath, lines.join('\n') + '\n');
  console.log(`📝 已更新 .sbot: FEISHU_BOT_NAME=${bot.name}`);
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

    // 2. 判断是否切换了 bot → 切换则清空旧 chatIds
    const prevAppId = process.env.FEISHU_APP_ID || '';
    const switched = prevAppId && prevAppId !== bot.appId;
    if (switched) {
      console.log(`\n🔄 切换 Bot: ${prevAppId} → ${bot.name}`);
    }

    const existingChatIds = switched ? [] : (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean);
    let chatIds: string[];

    if (existingChatIds.length > 0) {
      chatIds = existingChatIds;
      console.log(`\n✅ 使用已配置的会话: ${chatIds.join(', ')}`);
    } else {
      // 没有才获取会话列表
      const client = new lark.Client({
        appId: bot.appId,
        appSecret: bot.appSecret,
        disableTokenCache: false,
      });
      chatIds = await selectChats(rl, client);

      if (chatIds.length === 0) {
        console.log('ℹ️  未选择会话，启动后自动发现（给 bot 发消息即可注册）');
      }
    }

    // 3. 保存到 ~/.shrimpbot/config.json（不写 .env）
    saveShrimpBotState(bot, chatIds);

    // 4. 写入环境变量（当前进程使用）
    process.env.FEISHU_APP_ID = bot.appId;
    process.env.FEISHU_APP_SECRET = bot.appSecret;
    process.env.FEISHU_CHAT_IDS = chatIds.join(',');
    process.env.FEISHU_BOT_NAME = bot.name;

    console.log('\n🚀 配置完成，运行 sbot 启动 Bridge');

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
