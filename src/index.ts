#!/usr/bin/env node
// src/index.ts

import * as fs from 'fs';
import * as os from 'os';
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

// sbot 自己的参数（只解析这些，其余全部透传给 Claude）
const SBOT_FLAGS = new Set(['--debug', '--clone', '-h', '--help']);
const SBOT_OPTIONS = new Set(['-c', '--command', '--cwd', '--chat', '--app-id', '--app-secret', '--name']);

interface CliArgs {
  command?: string;
  cwd?: string;
  chatId?: string;
  debug?: boolean;
  clone?: boolean;
  appId?: string;
  appSecret?: string;
  name?: string;
  /** 是否是 init 子命令 */
  isInit: boolean;
  /** 透传给 Claude Code 的参数 */
  claudeArgs: string[];
}

function parseArgs(): CliArgs {
  const args: CliArgs = { isInit: false, claudeArgs: [] };
  const argv = process.argv.slice(2);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    // init 子命令
    if (arg === 'init') {
      args.isInit = true;
      i++;
      continue;
    }

    // sbot 带值参数
    if (SBOT_OPTIONS.has(arg)) {
      const value = argv[++i];
      switch (arg) {
        case '-c':
        case '--command': args.command = value; break;
        case '--cwd': args.cwd = value; break;
        case '--chat': args.chatId = value; break;
        case '--app-id': args.appId = value; break;
        case '--app-secret': args.appSecret = value; break;
        case '--name': args.name = value; break;
      }
      i++;
      continue;
    }

    // sbot 开关参数
    if (SBOT_FLAGS.has(arg)) {
      switch (arg) {
        case '--debug': args.debug = true; break;
        case '--clone': args.clone = true; break;
      }
      i++;
      continue;
    }

    // 其他参数全部透传给 Claude
    args.claudeArgs.push(arg);
    i++;
  }

  return args;
}

function printHelp(): void {
  console.log(`
sbot — 飞书 <-> Claude Code 实时通信桥

用法: sbot [命令] [sbot选项] [claude选项...]

命令:
  init                     初始化配置（交互式或参数式）

sbot 选项:
  -c, --command <文本>     启动后自动发送的命令
  --cwd <目录>             Claude Code 工作目录
  --chat <chat_id>         指定飞书会话 ID
  --debug                  开启调试日志
  --clone                  飞书与终端完全同步（多行完整显示）
  -h, --help               显示帮助

init 选项:
  --app-id <id>            飞书 App ID
  --app-secret <secret>    飞书 App Secret
  --name <名称>            Bot 名称
  --chat <chat_id>         飞书会话 ID

Claude 选项（全部透传给 Claude Code CLI）:
  -m, --model              指定模型
  --resume                 恢复上次会话
  --allowedTools           限制可用工具
  --max-turns              最大对话轮次
  ... 以及 Claude Code 支持的任何参数

示例:
  sbot                                 启动交互模式
  sbot init                            交互式初始化
  sbot init --app-id cli_xxx --app-secret yyy --name "小虾虾"
  sbot --clone                         飞书完全同步模式
  sbot -c "列出文件"                    启动并自动执行命令
  sbot --cwd /tmp --model claude-opus  sbot 参数 + Claude 参数混用
`);
}

const cliArgs = parseArgs();

// sbot 参数 → 环境变量
if (cliArgs.debug) process.env.LOG_LEVEL = 'debug';
if (cliArgs.cwd) process.env.CLAUDE_CWD = cliArgs.cwd;
if (cliArgs.chatId) process.env.FEISHU_CHAT_IDS = cliArgs.chatId;

// Claude 透传参数（CLI 的优先于环境变量的）
const claudeExtraArgs = cliArgs.claudeArgs;

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

/**
 * sbot init：初始化配置
 * 支持 --app-id / --app-secret / --name 参数（非交互式）
 * 或无参数时进入交互式向导
 */
async function handleInit(): Promise<void> {
  console.log('🦐 ShrimpBot — 初始化配置\n');

  let appId = cliArgs.appId;
  let appSecret = cliArgs.appSecret;
  let name = cliArgs.name || 'ShrimpBot';
  let chatIds = cliArgs.chatId ? [cliArgs.chatId] : [] as string[];

  // 参数不全 → 交互式向导
  if (!appId || !appSecret) {
    const config = await setupWizard();
    appId = config.feishuAppId;
    appSecret = config.feishuAppSecret;
    chatIds = config.chatIds;
  } else {
    // 参数完整 → 写入 bots.json（按 app-id 判断新增或更新）
    const botsPath = path.join(os.homedir(), '.shrimpbot', 'bots.json');
    let bots: Array<{ name: string; appId: string; appSecret: string }> = [];
    if (fs.existsSync(botsPath)) {
      try { bots = JSON.parse(fs.readFileSync(botsPath, 'utf-8')); } catch { /* ignore */ }
    }

    const existing = bots.find(b => b.appId === appId);
    if (existing) {
      // 已有 → 更新 name 和 appSecret
      if (appSecret) existing.appSecret = appSecret;
      if (cliArgs.name) existing.name = name;
      console.log(`✅ 已更新 Bot "${existing.name}" (${appId})`);
    } else {
      // 没有 → 添加
      bots.push({ name, appId, appSecret });
      console.log(`✅ 已添加 Bot "${name}" (${appId})`);
    }

    const dir = path.dirname(botsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(botsPath, JSON.stringify(bots, null, 2));
    console.log(`   保存到 ${botsPath}`);

    // 写 .env
    const envLines = [
      'FEISHU_MODE=bridge',
      `FEISHU_APP_ID=${appId}`,
      `FEISHU_APP_SECRET=${appSecret}`,
      `FEISHU_CHAT_IDS=${chatIds.join(',')}`,
      `FEISHU_BOT_NAME=${name}`,
    ];
    const envPath = path.join(process.cwd(), '.env');
    fs.writeFileSync(envPath, envLines.join('\n') + '\n');
    console.log(`✅ 已保存配置到 ${envPath}`);

    // 写入环境变量供当前进程使用
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = appSecret;
    process.env.FEISHU_CHAT_IDS = chatIds.join(',');
    process.env.FEISHU_BOT_NAME = name;
  }

  // init 后直接启动 bridge
  console.log('\n🚀 配置完成，正在启动 Bridge...\n');
  process.env.FEISHU_MODE = 'bridge';
  await startBridgeMode();
}

async function main() {
  // sbot init 子命令：初始化配置后直接启动
  if (cliArgs.isInit) {
    await handleInit();
    return;
  }

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
