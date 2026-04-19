// src/master.ts

import type { MultiBotConfig, BotConfig } from './types/index.js';
import { spawn, ChildProcess } from 'child_process';

export class Master {
  private botProcesses: Map<string, ChildProcess> = new Map();
  private chatIdToBot: Map<string, string> = new Map();

  constructor(private config: MultiBotConfig) {
    // 构建 chat_id → bot 映射
    for (const bot of config.bots) {
      for (const chatId of bot.chatIds) {
        this.chatIdToBot.set(chatId, bot.name);
      }
    }
  }

  async start(): Promise<void> {
    // 启动每个 Bot 子进程
    for (const bot of this.config.bots) {
      this.startBotProcess(bot);
    }
    console.error('Master started with', this.config.bots.length, 'bots');
  }

  private startBotProcess(bot: BotConfig): void {
    const child = spawn('node', ['dist/bot.js'], {
      env: {
        ...process.env,
        FEISHU_BOT_NAME: bot.name,
        FEISHU_APP_ID: bot.appId,
        FEISHU_APP_SECRET: bot.appSecret,
        FEISHU_CHAT_IDS: bot.chatIds.join(','),
        FEISHU_MODE: 'bot',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    child.on('exit', (code) => {
      console.error(`Bot ${bot.name} exited with code ${code}, restarting...`);
      setTimeout(() => this.startBotProcess(bot), 1000);
    });

    child.stderr?.on('data', (data) => {
      console.error(`Bot ${bot.name} stderr: ${data}`);
    });

    this.botProcesses.set(bot.name, child);
  }

  routeByChatId(chatId: string): string | undefined {
    return this.chatIdToBot.get(chatId);
  }

  stop(): void {
    for (const [name, proc] of this.botProcesses) {
      proc.kill();
      console.error(`Stopped bot: ${name}`);
    }
  }
}
