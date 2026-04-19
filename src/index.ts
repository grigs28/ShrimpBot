import { MCPServer } from './server.js';
import { loadMultiBotConfig, loadSingleBotConfig } from './config.js';
import { Master } from './master.js';
import { startBot } from './bot.js';
import type { Config } from './types/index.js';

function getConfig(): Config {
  const single = loadSingleBotConfig();
  const port = parseInt(process.env.FEISHU_WEBHOOK_PORT || '8080', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('Invalid FEISHU_WEBHOOK_PORT must be a number between 1 and 65535');
  }
  return {
    feishuAppId: single.appId,
    feishuAppSecret: single.appSecret,
    botName: single.name,
    chatIds: single.chatIds,
    webhookPort: port,
    debug: process.env.DEBUG === 'true',
  };
}

async function main() {
  const mode = process.env.FEISHU_MODE || 'single';

  if (mode === 'master') {
    const config = loadMultiBotConfig();
    const master = new Master(config);
    await master.start();
    process.on('SIGINT', () => master.stop());
  } else {
    const config = getConfig();
    if (!config.feishuAppId || !config.feishuAppSecret) {
      console.error('错误：需要设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
      process.exit(1);
    }
    await startBot(config);
  }
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
