// src/bot.ts

import { MCPServer } from './server.js';
import type { BotConfig } from './types/index.js';

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

  // 监听 stdin 接收来自 Master 的消息
  process.stdin.on('data', async (data) => {
    try {
      const line = data.toString().trim();
      if (!line) return;
      const msg = JSON.parse(line);
      await server.handleIncomingMessage(msg);
    } catch (err) {
      console.error(`Bot ${config.name} failed to process message:`, err);
    }
  });

  try {
    await server.start();
  } catch (err) {
    console.error(`Bot ${config.name} failed to start:`, err);
    throw err;
  }
}
