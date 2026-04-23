import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MultiBotConfig, BotConfig } from './types/index.js';

const SHRIMPBOT_DIR = path.join(os.homedir(), '.shrimpbot');
const BOTS_PATH = path.join(SHRIMPBOT_DIR, 'bots.json');
const CONFIG_PATH = path.join(SHRIMPBOT_DIR, 'config.json');

interface BotEntry {
  name: string;
  appId: string;
  appSecret: string;
  chatIds?: string[];
}

interface ShrimpBotConfig {
  activeBotName?: string;
  chatIds?: string[];
  claudeCwd?: string;
}

export function loadBotsRegistry(): BotEntry[] {
  if (!fs.existsSync(BOTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(BOTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveBotsRegistry(bots: BotEntry[]): void {
  if (!fs.existsSync(SHRIMPBOT_DIR)) fs.mkdirSync(SHRIMPBOT_DIR, { recursive: true });
  fs.writeFileSync(BOTS_PATH, JSON.stringify(bots, null, 2));
}

function findBotByName(name: string): BotEntry | undefined {
  const bots = loadBotsRegistry();
  return bots.find(b => b.name === name);
}

/** 读取 ShrimpBot 运行时配置 */
export function loadShrimpBotConfig(): ShrimpBotConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** 保存 ShrimpBot 运行时配置 */
export function saveShrimpBotConfig(config: ShrimpBotConfig): void {
  if (!fs.existsSync(SHRIMPBOT_DIR)) fs.mkdirSync(SHRIMPBOT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** 更新部分配置（合并） */
export function updateShrimpBotConfig(partial: Partial<ShrimpBotConfig>): void {
  const current = loadShrimpBotConfig();
  const merged = { ...current, ...partial };
  saveShrimpBotConfig(merged);
}

/** 追加 chatId 到当前活跃 bot（去重） */
export function addChatId(chatId: string): void {
  const config = loadShrimpBotConfig();
  const botName = config.activeBotName;
  if (!botName) return;

  const bots = loadBotsRegistry();
  const bot = bots.find(b => b.name === botName);
  if (!bot) return;

  if (!bot.chatIds) bot.chatIds = [];
  if (!bot.chatIds.includes(chatId)) {
    bot.chatIds.push(chatId);
    saveBotsRegistry(bots);
  }
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
 * 优先级：环境变量 > config.json activeBotName > config.json + bots.json 第一个
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

  // 2. 从环境变量（.sbot）或 config.json 的 activeBotName 查找 bots.json
  const shrimpConfig = loadShrimpBotConfig();
  const botName = process.env.FEISHU_BOT_NAME || shrimpConfig.activeBotName;

  if (botName) {
    const bot = findBotByName(botName);
    if (bot) {
      return {
        name: bot.name,
        appId: bot.appId,
        appSecret: bot.appSecret,
        chatIds: bot.chatIds || [],
      };
    }
  }

  // 3. 从 bots.json 取第一个 bot
  const bots = loadBotsRegistry();
  if (bots.length > 0) {
    const bot = bots[0]!;
    return {
      name: bot.name,
      appId: bot.appId,
      appSecret: bot.appSecret,
      chatIds: bot.chatIds || [],
    };
  }

  // 4. 无凭证
  return {
    name: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
    appId: '',
    appSecret: '',
    chatIds: shrimpConfig.chatIds || [],
  };
}
