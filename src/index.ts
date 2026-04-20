// src/index.ts

import * as fs from 'fs';
import * as path from 'path';
import { MCPServer } from './server.js';
import { loadMultiBotConfig, loadSingleBotConfig } from './config.js';
import { Master } from './master.js';
import { startBot } from './bot.js';
import { FeishuBridge } from './pty/feishu-bridge.js';
import { setupWizard } from './setup.js';
import { logger } from './logger.js';
import type { Config } from './types/index.js';

/**
 * 从当前目录加载 .env 文件到 process.env
 * 不覆盖已有环境变量
 */
function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // 不覆盖已有的（命令行传入的优先）
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// 尽早加载 .env
loadEnvFile();

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

async function startBridgeMode(): Promise<void> {
  let appId = process.env.FEISHU_APP_ID;
  let appSecret = process.env.FEISHU_APP_SECRET;
  let chatIds = (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean);
  const allowedUsers = (process.env.FEISHU_ALLOWED_USERS || '').split(',').filter(Boolean);

  // 没有凭证 → 首次启动向导（空 chatIds 表示接受所有会话，不触发向导）
  if (!appId || !appSecret) {
    logger.info('Main', '未检测到配置，启动向导...');
    const config = await setupWizard();
    appId = config.feishuAppId;
    appSecret = config.feishuAppSecret;
    chatIds = config.chatIds;
  }

  const bridge = new FeishuBridge({
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    botName: process.env.FEISHU_BOT_NAME,
    chatIds,
    allowedUsers,
    claudePath: process.env.CLAUDE_PATH,
    claudeCwd: process.env.CLAUDE_CWD,
    claudeExtraArgs: process.env.CLAUDE_EXTRA_ARGS?.split(' ').filter(Boolean),
  });

  await bridge.start();

  process.on('SIGINT', () => {
    logger.info('Main', '收到 SIGINT，关闭...');
    bridge.stop();
    logger.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    bridge.stop();
    logger.close();
    process.exit(0);
  });
}

async function main() {
  const mode = process.env.FEISHU_MODE || 'single';

  if (mode === 'bridge') {
    await startBridgeMode();
  } else if (mode === 'master') {
    const config = loadMultiBotConfig();
    const master = new Master(config);
    await master.start();
    process.on('SIGINT', () => {
      master.stop();
      process.exit(0);
    });
  } else {
    const config = getConfig();
    if (!config.feishuAppId || !config.feishuAppSecret) {
      console.error('错误：需要设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量');
      process.exit(1);
    }
    await startBot({
      name: config.botName,
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      chatIds: config.chatIds,
    });
  }
}

// 全局异常处理
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
