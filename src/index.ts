#!/usr/bin/env node
// src/index.ts

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from './server.js';
import { loadMultiBotConfig, loadSingleBotConfig, saveShrimpBotConfig } from './config.js';
import { Master } from './master.js';
import { startBot } from './bot.js';
import { FeishuBridge } from './pty/feishu-bridge.js';
import { PTYManager } from './pty/pty-manager.js';
import { WebServer } from './pty/web-server.js';
import { ensureHookSettings } from './pty/hook-settings.js';
import { setupWizard } from './setup.js';
import { logger } from './logger.js';
import type { Config } from './types/index.js';

// ========== CLI 参数解析 ==========

// sbot 自己的参数（只解析这些，其余全部透传给 Claude）
const SBOT_FLAGS = new Set(['--debug', '--clone', '--web', '--web-server', '-h', '--help']);
const SBOT_OPTIONS = new Set(['--command', '--cwd', '--chat', '--app-id', '--app-secret', '--name']);

interface CliArgs {
  command?: string;
  cwd?: string;
  chatId?: string;
  debug?: boolean;
  clone?: boolean;
  web?: boolean;
  webServer?: boolean;
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
      const value = argv[i + 1];
      // 下一个参数是 flag 或不存在 → 跳过（不把 flag 误吞为值）
      if (!value || value.startsWith('-')) {
        i++;
        continue;
      }
      i++;
      switch (arg) {
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
        case '--web': args.web = true; break;
        case '--web-server': args.webServer = true; break;
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
  --command <文本>          启动后自动发送的命令
  --cwd <目录>             Claude Code 工作目录
  --chat <chat_id>         指定飞书会话 ID
  --debug                  开启调试日志
  --clone                  飞书与终端完全同步（多行完整显示）
  --web                    启用 Web 终端（飞书+终端+Web 三端模式）
                            仅 --web 不带飞书配置时为纯 Web 模式
  --web-server             独立 Web 服务（不启动 PTY/飞书，仅 Web UI + API）
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
  sbot --web                           飞书+终端+Web 三端模式
  sbot --web (无飞书配置时)              纯 Web 终端模式（端口 5554）
  sbot --command "列出文件"               启动并自动执行命令
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
 * 从当前目录加载项目配置文件（.sbot）到 process.env
 * 不覆盖已有环境变量（命令行/全局配置优先）
 */
function loadProjectConfig(): void {
  const configPath = path.join(process.cwd(), '.sbot');
  if (!fs.existsSync(configPath)) return;

  const content = fs.readFileSync(configPath, 'utf-8');
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

// 尽早加载项目级配置（.sbot）
loadProjectConfig();

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

async function startWebOnlyMode(): Promise<void> {
  const webPort = parseInt(process.env.WEB_PORT || '5554', 10);

  // 检查端口
  const available = await WebServer.isPortAvailable(webPort);
  if (!available) {
    logger.error('Main', `端口 ${webPort} 已被占用，无法启动 Web 终端`);
    process.exit(1);
  }

  const extraArgs = [
    ...(process.env.CLAUDE_EXTRA_ARGS?.split(' ').filter(Boolean) || []),
    ...claudeExtraArgs,
  ];

  // 写入 hook 配置
  ensureHookSettings(webPort);

  const pty = new PTYManager({
    claudePath: process.env.CLAUDE_PATH,
    cwd: process.env.CLAUDE_CWD,
    extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    botName: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
  });

  const webServer = new WebServer({
    onPtyData: (cb) => { pty.onRawData(cb); },
    ptyWrite: (data) => { pty.writeRaw(data); },
    getBufferText: () => pty.getBufferText(),
    getTerminalSize: () => pty.getTerminalSize(),
    botName: process.env.FEISHU_BOT_NAME || 'ShrimpBot',
  }, webPort);

  pty.start();
  await webServer.start();

  logger.info('Main', `Web-Only 模式启动完成: http://localhost:${webPort}`);

  // -c 初始命令
  if (cliArgs.command) {
    setTimeout(() => {
      logger.info('Main', `执行初始命令: "${cliArgs.command}"`);
      pty.send(cliArgs.command!);
    }, 3000);
  }

  // 终端透传
  if (process.stdin.isTTY) {
    logger.setStderrEnabled(false);
    console.warn = () => {};
    console.error = () => {};
    pty.onRawData((data: string) => { process.stdout.write(data); });
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString();
      if (input === '\x03' || input === '\x04') {
        pty.stop();
        process.exit(0);
      }
      pty.writeRaw(input);
    });
    const resize = () => {
      pty.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    };
    resize();
    process.stdout.on('resize', resize);
  }

  const cleanup = () => {
    webServer.stop();
    pty.stop();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/** 独立 Web 服务（不启动 PTY/飞书，仅 Web UI + Hook API） */
async function startStandaloneWebServer(): Promise<void> {
  const webPort = parseInt(process.env.WEB_PORT || '5554', 10);

  const available = await WebServer.isPortAvailable(webPort);
  if (!available) {
    logger.error('Main', `端口 ${webPort} 已被占用`);
    process.exit(1);
  }

  const webServer = new WebServer({
    botName: 'ShrimpBot Hub',
  }, webPort);

  await webServer.start();
  logger.info('Main', `独立 Web 服务已启动: http://localhost:${webPort}`);

  process.on('SIGINT', () => {
    webServer.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    webServer.stop();
    process.exit(0);
  });
}

async function startBridgeMode(): Promise<void> {
  // CLI 参数覆盖
  let appId = cliArgs.appId || process.env.FEISHU_APP_ID;
  let appSecret = cliArgs.appSecret || process.env.FEISHU_APP_SECRET;
  let chatIds = cliArgs.chatId
    ? [cliArgs.chatId]
    : (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean);

  // 无凭证 → 从 config.json + bots.json 加载
  let botName = process.env.FEISHU_BOT_NAME;
  if (!appId || !appSecret || !botName) {
    const botConfig = loadSingleBotConfig();
    if (!appId) appId = botConfig.appId;
    if (!appSecret) appSecret = botConfig.appSecret;
    if (chatIds.length === 0) chatIds = botConfig.chatIds;
    if (!botName) botName = botConfig.name;
  }

  const allowedUsers = (process.env.FEISHU_ALLOWED_USERS || '').split(',').filter(Boolean);

  // 没有飞书凭证
  if (!appId || !appSecret) {
    // --web 时跳过向导，走纯 Web 模式
    if (cliArgs.web) {
      logger.info('Main', '无飞书配置，--web 模式启动纯 Web 终端');
      await startWebOnlyMode();
      return;
    }
    // 否则启动向导
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

  // 写入 hook 配置到 .claude/settings.local.json
  const webPort = parseInt(process.env.WEB_PORT || '5554', 10);
  ensureHookSettings(webPort);

  const bridge = new FeishuBridge({
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    botName,
    chatIds,
    allowedUsers,
    claudePath: process.env.CLAUDE_PATH,
    claudeCwd: process.env.CLAUDE_CWD,
    claudeExtraArgs: extraArgs.length > 0 ? extraArgs : undefined,
    clone: cliArgs.clone,
    webEnabled: cliArgs.web,
    webPort: parseInt(process.env.WEB_PORT || '5554', 10),
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

/** 保存活跃 bot 到 ~/.shrimpbot/config.json */
function saveActiveBot(botName: string, chatIds: string[]): void {
  saveShrimpBotConfig({
    activeBotName: botName,
    chatIds,
    claudeCwd: process.cwd(),
  });
  console.log(`✅ 已切换到 "${botName}"，配置写入 ~/.shrimpbot/config.json`);
}

/**
 * sbot init：初始化/切换配置
 * 支持 --app-id / --app-secret / --name 参数（非交互式）
 * 或无参数时进入交互式向导（选择已有 bot 或添加新的）
 */
async function handleInit(): Promise<void> {
  // 有完整参数 → 非交互式，直接写 bots.json + config.json
  if (cliArgs.appId && cliArgs.appSecret) {
    const name = cliArgs.name || 'ShrimpBot';
    const chatIds = cliArgs.chatId ? [cliArgs.chatId] : [] as string[];

    const botsPath = path.join(os.homedir(), '.shrimpbot', 'bots.json');
    let bots: Array<{ name: string; appId: string; appSecret: string }> = [];
    if (fs.existsSync(botsPath)) {
      try { bots = JSON.parse(fs.readFileSync(botsPath, 'utf-8')); } catch { /* ignore */ }
    }

    const existing = bots.find(b => b.appId === cliArgs.appId);
    if (existing) {
      if (cliArgs.appSecret) existing.appSecret = cliArgs.appSecret;
      if (cliArgs.name) existing.name = name;
      console.log(`✅ 已更新 Bot "${existing.name}" (${cliArgs.appId})`);
    } else {
      bots.push({ name, appId: cliArgs.appId, appSecret: cliArgs.appSecret });
      console.log(`✅ 已添加 Bot "${name}" (${cliArgs.appId})`);
    }

    const dir = path.dirname(botsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(botsPath, JSON.stringify(bots, null, 2));

    // 写 config.json（切换活跃 bot，不写 .env）
    saveActiveBot(name, chatIds);
    return;
  }

  // 无参数或参数不全 → 交互式向导（选择已有 bot 或添加新的）
  await setupWizard();
}

async function main() {
  // sbot init 子命令：初始化配置后直接启动
  if (cliArgs.isInit) {
    await handleInit();
    return;
  }

  // --web-server：独立 Web 服务（不启动 PTY/飞书，仅 Web UI + Hook API）
  if (cliArgs.webServer) {
    await startStandaloneWebServer();
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
