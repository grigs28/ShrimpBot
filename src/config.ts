import type { MultiBotConfig, BotConfig } from './types/index.js';

export function loadMultiBotConfig(): MultiBotConfig {
  const botsJson = process.env.FEISHU_BOTS || '[]';
  try {
    return JSON.parse(botsJson);
  } catch {
    throw new Error('Invalid FEISHU_BOTS JSON');
  }
}

export function loadSingleBotConfig(): BotConfig {
  return {
    name: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
  };
}
