// src/bot.ts

import { MCPServer } from './server.js';
import type { BotConfig } from './types/index.js';
import * as readline from 'readline';

export async function startBot(config: BotConfig): Promise<void> {
  const server = new MCPServer({
    feishuAppId: config.appId,
    feishuAppSecret: config.appSecret,
    botName: config.name,
    chatIds: config.chatIds,
    webhookPort: 8080,
    debug: process.env.DEBUG === 'true',
  });

  console.error(`Bot ${config.name} starting for chatIds: ${config.chatIds.join(', ')}`);

  // 使用 readline 正确处理 stdin 行缓冲
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    try {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      await server.handleIncomingMessage(msg);
    } catch (err) {
      console.error(`Bot ${config.name} failed to process message:`, err);
    }
  });

  rl.on('close', () => {
    console.error(`Bot ${config.name} stdin closed`);
    process.exit(0);
  });

  try {
    await server.start();
  } catch (err) {
    console.error(`Bot ${config.name} failed to start:`, err);
    throw err;
  }
}
