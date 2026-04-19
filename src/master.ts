// src/master.ts

import http from 'http';
import type { MultiBotConfig, BotConfig } from './types/index.js';
import { spawn, ChildProcess } from 'child_process';

interface RestartRecord {
  count: number;
  firstAttempt: number;
}

export class Master {
  private botProcesses: Map<string, ChildProcess> = new Map();
  private pendingRestarts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private botRestartCounts: Map<string, RestartRecord> = new Map();
  private readonly MAX_RESTART_ATTEMPTS = 5;
  private readonly RESTART_WINDOW_MS = 60000; // 1分钟内
  private chatIdToBot: Map<string, string> = new Map();
  private routerServer: http.Server;

  constructor(private config: MultiBotConfig) {
    for (const bot of config.bots) {
      for (const chatId of bot.chatIds) {
        this.chatIdToBot.set(chatId, bot.name);
      }
    }

    // 创建 HTTP 路由服务器
    this.routerServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/route') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { chat_id, content } = JSON.parse(body);
            const botName = this.routeByChatId(chat_id);
            if (!botName) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bot not found for chat_id' }));
              return;
            }
            const bot = this.botProcesses.get(botName);
            if (!bot || !bot.stdin) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Bot process not available' }));
              return;
            }
            // 发送到对应 Bot
            bot.stdin.write(JSON.stringify({ chat_id, content }) + '\n');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, bot: botName }));
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            }
          }
        });
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bots: this.config.bots.length }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  }

  async start(): Promise<void> {
    // 启动每个 Bot 子进程
    for (const bot of this.config.bots) {
      this.startBotProcess(bot);
    }

    // 启动 HTTP 路由服务器
    const port = parseInt(process.env.FEISHU_ROUTER_PORT || '9090', 10);
    this.routerServer.listen(port, () => {
      console.error(`Router server listening on port ${port}`);
    });

    this.routerServer.on('error', (err) => {
      if ((err as any).code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use`);
      } else {
        console.error(`Router server error: ${err.message}`);
      }
      process.exit(1);
    });

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
        const now = Date.now();
        const lastRestart = this.botRestartCounts.get(bot.name) || { count: 0, firstAttempt: now };

        if (now - lastRestart.firstAttempt > this.RESTART_WINDOW_MS) {
          // 重启窗口过期，重置计数
          lastRestart.count = 0;
          lastRestart.firstAttempt = now;
        }

        lastRestart.count++;
        this.botRestartCounts.set(bot.name, lastRestart);

        if (lastRestart.count <= this.MAX_RESTART_ATTEMPTS) {
          console.error(`Bot ${bot.name} exited with code ${code}, restarting (${lastRestart.count}/${this.MAX_RESTART_ATTEMPTS})...`);
          const timeout = setTimeout(() => this.startBotProcess(bot), 1000);
          this.pendingRestarts.set(bot.name, timeout);
        } else {
          console.error(`Bot ${bot.name} exceeded max restart attempts, giving up`);
        }
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

    // 关闭 HTTP 服务器
    this.routerServer.close();

    // 终止所有进程
    const botNames = Array.from(this.botProcesses.keys());
    for (const name of botNames) {
      const proc = this.botProcesses.get(name);
      if (proc) {
        proc.kill();
        this.botProcesses.delete(name);
      }
    }
  }
}
