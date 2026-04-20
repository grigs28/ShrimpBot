import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MultiBotConfig, BotConfig } from './types/index.js';

const BOTS_PATH = path.join(os.homedir(), '.shrimpbot', 'bots.json');

interface BotEntry {
  name: string;
  appId: string;
  appSecret: string;
}

function loadBotsRegistry(): BotEntry[] {
  if (!fs.existsSync(BOTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(BOTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function findBotByName(name: string): BotEntry | undefined {
  const bots = loadBotsRegistry();
  return bots.find(b => b.name === name);
}

export function loadMultiBotConfig(): MultiBotConfig {
  const botsJson = process.env.FEISHU_BOTS || '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(botsJson);
  } catch (e) {
    throw new Error(`Invalid FEISHU_BOTS JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).bots)) {
    throw new Error('FEISHU_BOTS must be a JSON object with a "bots" array');
  }
  const config = parsed as MultiBotConfig;
  for (const bot of config.bots) {
    if (!bot.name || !bot.appId || !bot.appSecret) {
      throw new Error(`Each bot must have name, appId, and appSecret. Got: ${JSON.stringify({ name: bot.name, appId: bot.appId })}`);
    }
    if (!Array.isArray(bot.chatIds)) {
      throw new Error(`Bot ${bot.name}: chatIds must be an array`);
    }
  }
  if (config.bots.length === 0) {
    throw new Error('FEISHU_BOTS must contain at least one bot configuration');
  }
  return config;
}

/**
 * 加载单个 bot 配置
 * 优先级：环境变量 > SHRIMPBOT_BOT_NAME 引用 bots.json > bots.json 第一个
 */
export function loadSingleBotConfig(): BotConfig {
  // 1. 环境变量直接提供凭证（最高优先级，向后兼容）
  const envAppId = process.env.FEISHU_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET;
  if (envAppId && envAppSecret) {
    return {
      name: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
      appId: envAppId,
      appSecret: envAppSecret,
      chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
    };
  }

  // 2. 通过 SHRIMPBOT_BOT_NAME 从 bots.json 查找
  const botName = process.env.SHRIMPBOT_BOT_NAME;
  if (botName) {
    const bot = findBotByName(botName);
    if (bot) {
      return {
        name: bot.name,
        appId: bot.appId,
        appSecret: bot.appSecret,
        chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
      };
    }
    console.error(`Warning: SHRIMPBOT_BOT_NAME="${botName}" not found in ${BOTS_PATH}`);
  }

  // 3. 从 bots.json 取第一个 bot
  const bots = loadBotsRegistry();
  if (bots.length > 0) {
    const bot = bots[0]!;
    return {
      name: bot.name,
      appId: bot.appId,
      appSecret: bot.appSecret,
      chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
    };
  }

  // 4. 无凭证
  return {
    name: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
    appId: '',
    appSecret: '',
    chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
  };
}
