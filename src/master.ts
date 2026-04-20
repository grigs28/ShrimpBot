// src/master.ts

import http from 'http';
import type { MultiBotConfig, BotConfig } from './types/index.js';
import { spawn, ChildProcess } from 'child_process';

interface RestartRecord {
  count: number;
  firstAttempt: number;
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB 请求体限制

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
        let bodySize = 0;
        req.on('data', chunk => {
          bodySize += chunk.length;
          if (bodySize > MAX_BODY_SIZE) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('error', (err) => {
          console.error('Request error:', err.message);
        });
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

    // 先注册错误处理再监听
    this.routerServer.on('error', (err) => {
      if ((err as any).code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use`);
      } else {
        console.error(`Router server error: ${err.message}`);
      }
      process.exit(1);
    });

    this.routerServer.listen(port, () => {
      console.error(`Router server listening on port ${port}`);
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

    // 通过 IPC 通道发送凭据（避免环境变量泄露）
    child.send({ type: 'credentials', appId: bot.appId, appSecret: bot.appSecret });

    child.on('exit', (code, signal) => {
      // 被信号杀死时 code 为 null，也需要重启
      if (code !== 0 || signal !== null) {
        const now = Date.now();
        const prev = this.botRestartCounts.get(bot.name);
        const firstAttempt = (!prev || now - prev.firstAttempt > this.RESTART_WINDOW_MS) ? now : prev.firstAttempt;
        const count = (!prev || now - prev.firstAttempt > this.RESTART_WINDOW_MS) ? 1 : prev.count + 1;
        this.botRestartCounts.set(bot.name, { count, firstAttempt });

        if (count <= this.MAX_RESTART_ATTEMPTS) {
          console.error(`Bot ${bot.name} exited with code ${code} signal ${signal}, restarting (${count}/${this.MAX_RESTART_ATTEMPTS})...`);
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

    // 优雅终止所有进程
    const botNames = Array.from(this.botProcesses.keys());
    for (const name of botNames) {
      const proc = this.botProcesses.get(name);
      if (proc) {
        proc.kill(); // SIGTERM
        const forceKill = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 5000);
        proc.on('exit', () => {
          clearTimeout(forceKill);
          this.botProcesses.delete(name);
        });
        this.botProcesses.delete(name);
      }
    }
  }
}
