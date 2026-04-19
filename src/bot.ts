import { MCPServer } from './server.js';
import type { Config } from './types/index.js';

export async function startBot(config: Config): Promise<void> {
  const server = new MCPServer({
    feishuAppId: config.feishuAppId,
    feishuAppSecret: config.feishuAppSecret,
    botName: config.botName,
    chatIds: config.chatIds,
    webhookPort: config.webhookPort,
    debug: config.debug,
  });

  console.error(`Bot ${config.botName} starting for chatIds: ${config.chatIds.join(', ')}`);
  await server.start();
}
