#!/usr/bin/env node
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

// ========== CLI 参数解析 ==========

interface CliArgs {
  command?: string;       // -c "命令" → 启动后自动发送
  cwd?: string;           // --cwd <目录>
  chatId?: string;        // --chat <chat_id>
  debug?: boolean;        // --debug
  model?: string;         // --model <模型名>
  resume?: boolean;       // --resume
  allowedTools?: string;  // --allowedTools
  maxTurns?: number;      // --max-turns
  clone?: boolean;        // --clone 飞书和终端完全同步
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-c':
      case '--command':
        args.command = argv[++i];
        break;
      case '--cwd':
        args.cwd = argv[++i];
        break;
      case '--chat':
        args.chatId = argv[++i];
        break;
      case '--debug':
        args.debug = true;
        break;
      case '--model':
      case '-m':
        args.model = argv[++i];
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--allowedTools':
        args.allowedTools = argv[++i];
        break;
      case '--max-turns':
        args.maxTurns = parseInt(argv[++i] || '0', 10);
        break;
      case '--clone':
        args.clone = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
sbot — 飞书 <-> Claude Code 实时通信桥

用法: sbot [选项]

选项:
  -c, --command <文本>     启动后自动发送的命令
  --cwd <目录>             Claude Code 工作目录
  --chat <chat_id>         指定飞书会话 ID
  --debug                  开启调试日志
  -m, --model <模型>       指定 Claude 模型
  --resume                 恢复上次会话
  --allowedTools <工具>    限制可用工具（逗号分隔）
  --max-turns <数字>       最大对话轮次
  --clone                  飞书与终端完全同步（多行完整显示）
  -h, --help               显示帮助

示例:
  sbot                         启动交互模式
  sbot -c "列出文件"           启动并自动执行命令
  sbot --cwd /my/project       指定工作目录
  sbot --debug                 调试模式
`);
}

const cliArgs = parseArgs();

// CLI 参数覆盖环境变量
if (cliArgs.debug) process.env.LOG_LEVEL = 'debug';
if (cliArgs.cwd) process.env.CLAUDE_CWD = cliArgs.cwd;
if (cliArgs.chatId) process.env.FEISHU_CHAT_IDS = cliArgs.chatId;

// 构建 Claude 额外参数
const claudeExtraArgs: string[] = [];
if (cliArgs.model) claudeExtraArgs.push('--model', cliArgs.model);
if (cliArgs.resume) claudeExtraArgs.push('--resume');
if (cliArgs.allowedTools) claudeExtraArgs.push('--allowedTools', cliArgs.allowedTools);
if (cliArgs.maxTurns) claudeExtraArgs.push('--max-turns', String(cliArgs.maxTurns));

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

  // 合并 CLI 参数和环境变量的额外参数
  const extraArgs = [
    ...(process.env.CLAUDE_EXTRA_ARGS?.split(' ').filter(Boolean) || []),
    ...claudeExtraArgs,
  ];

  const bridge = new FeishuBridge({
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    botName: process.env.FEISHU_BOT_NAME,
    chatIds,
    allowedUsers,
    claudePath: process.env.CLAUDE_PATH,
    claudeCwd: process.env.CLAUDE_CWD,
    claudeExtraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    clone: cliArgs.clone,
  });

  await bridge.start();

  // -c 初始命令：启动后自动发送
  if (cliArgs.command) {
    setTimeout(() => {
      logger.info('Main', `执行初始命令: "${cliArgs.command}"`);
      bridge.sendInitialCommand(cliArgs.command!);
    }, 3000);
  }

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
