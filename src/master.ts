// src/master.ts

import type { MultiBotConfig, BotConfig } from './types/index.js';
import { spawn, ChildProcess } from 'child_process';

export class Master {
  private botProcesses: Map<string, ChildProcess> = new Map();
  private pendingRestarts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private chatIdToBot: Map<string, string> = new Map();

  constructor(private config: MultiBotConfig) {
    for (const bot of config.bots) {
      for (const chatId of bot.chatIds) {
        this.chatIdToBot.set(chatId, bot.name);
      }
    }
  }

  async start(): Promise<void> {
    for (const bot of this.config.bots) {
      this.startBotProcess(bot);
    }
    console.error('Master started with', this.config.bots.length, 'bots');
  }

  private startBotProcess(bot: BotConfig): void {
    // 清除之前的重启定时器
    const existingTimeout = this.pendingRestarts.get(bot.name);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.pendingRestarts.delete(bot.name);
    }

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

    child.on('error', (err) => {
      console.error(`Bot ${bot.name} failed to start: ${err.message}`);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Bot ${bot.name} exited with code ${code}, restarting...`);
        const timeout = setTimeout(() => this.startBotProcess(bot), 1000);
        this.pendingRestarts.set(bot.name, timeout);
      }
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
    // 清除所有重启定时器
    for (const timeout of this.pendingRestarts.values()) {
      clearTimeout(timeout);
    }
    this.pendingRestarts.clear();

    // 终止所有进程
    for (const [name, proc] of this.botProcesses) {
      proc.kill();
      this.botProcesses.delete(name);
    }
  }
}
