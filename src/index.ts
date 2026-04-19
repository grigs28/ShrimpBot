import { MCPServer } from './server.js';
import { loadMultiBotConfig, loadSingleBotConfig } from './config.js';
import type { Config } from './types/index.js';

function getConfig(): Config {
  return {
    feishuAppId: process.env.FEISHU_APP_ID || '',
    feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
    botName: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
    chatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean),
    webhookPort: parseInt(process.env.FEISHU_WEBHOOK_PORT || '8080', 10),
    debug: process.env.DEBUG === 'true',
  };
}

async function main() {
  const config = getConfig();

  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('错误：需要设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
    process.exit(1);
  }

  const server = new MCPServer(config);
  await server.start();
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
