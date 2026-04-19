/**
 * ⚠️ EXPERIMENTAL — CLI Bridge with PTY + Stop Hook
 *
 * Architecture:
 * - PTY: Spawns Claude Code in a pseudo-terminal for full interactive UI
 * - Stop Hook: Forwards Claude's clean response text to Feishu (no garbled output)
 * - Feishu injection: Polls for Feishu messages and injects into Claude's stdin
 *
 * Claude → Feishu: via Stop hook (bin/bridge-stop-hook) — receives clean text
 * Feishu → Claude: via PTY stdin injection
 */
import { spawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import type { CardState } from '../types.js';

export interface BridgeOptions {
  chatId: string;
  botName: string;
  apiUrl: string;
  apiSecret?: string;
  workingDirectory?: string;
  sessionId?: string;
}

/**
 * CLIBridge — PTY-based bridge between Claude Code and Feishu.
 *
 * 1. Spawns Claude Code in a PTY (user sees and operates the real UI)
 * 2. Sets env vars so Claude Code's Stop hook can forward responses to Feishu
 * 3. Polls for Feishu messages → injects into Claude Code's stdin
 */
export class CLIBridge {
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private ptyProcess?: IPty;
  private running = false;
  private lastFeishuTimestamp = 0;

  constructor(private options: BridgeOptions) {}

  async start(): Promise<void> {
    // 1. Register with ShrimpBot
    const registerRes = await this.apiCall('POST', '/bridge/register', {
      chatId: this.options.chatId,
    });
    if (registerRes === null) {
      console.error(`\x1b[31m注册失败：chatId ${this.options.chatId} 已被其他 bridge 绑定或 API 错误\x1b[0m`);
      process.exit(1);
    }

    // 2. Send initial card to Feishu
    const initialState: CardState = {
      status: 'running',
      userPrompt: 'Bridge PTY 已连接',
      responseText: 'Claude Code 正在启动...',
      toolCalls: [],
    };
    await this.sendFeishuEvent('initial', initialState);

    // 3. Heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.apiCall('POST', '/bridge/heartbeat', { chatId: this.options.chatId }).catch(() => {});
    }, 10_000);

    // 4. Spawn Claude Code in PTY with bridge env vars for Stop hook
    const cwd = this.options.workingDirectory || process.cwd();
    this.ptyProcess = spawn('claude', [], {
      name: 'xterm-256color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      cwd,
      env: {
        ...process.env,
        // Pass bridge config to Claude Code's Stop hook via env
        SHRIMPBOT_BRIDGE_API: this.options.apiUrl,
        SHRIMPBOT_BRIDGE_CHAT: this.options.chatId,
        SHRIMPBOT_BRIDGE_BOT: this.options.botName,
        SHRIMPBOT_BRIDGE_SECRET: this.options.apiSecret || '',
      } as Record<string, string>,
    });

    // 5. Wire PTY ↔ real terminal (just pass-through, no output parsing)
    this.ptyProcess.onData((data: string) => {
      process.stdout.write(data);
    });

    this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.running = false;
      console.log(`\n\x1b[33mClaude Code exited (code ${exitCode}). Bridge closing...\x1b[0m`);
      this.cleanup().then(() => process.exit(exitCode));
    });

    // Forward user keystrokes to PTY (raw mode for full terminal control)
    process.stdin.setRawMode(true);
    process.stdin.on('data', (data: Buffer) => {
      this.ptyProcess?.write(data.toString('utf8'));
    });

    // 6. Poll Feishu messages and inject into Claude
    this.running = true;
    this.pollInterval = setInterval(() => {
      this.pollAndInject().catch(() => {});
    }, 1000);

    // Handle terminal resize
    process.stdout.on('resize', () => {
      this.ptyProcess?.resize(
        process.stdout.columns || 120,
        process.stdout.rows || 40,
      );
    });

    console.error('\x1b[32mBridge PTY 已启动。Claude Code 输出通过 Stop hook 转发飞书。\x1b[0m');
  }

  async cleanup(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    this.ptyProcess?.kill();
    await this.apiCall('POST', '/bridge/unregister', {
      chatId: this.options.chatId,
    });
  }

  // ─── Feishu message injection ──────────────────────────────────────

  private async pollAndInject(): Promise<void> {
    if (!this.running || !this.ptyProcess) return;
    const msg = await this.apiCall('GET', `/bridge/messages/${this.options.chatId}`);
    if (msg && msg.text && msg.timestamp > this.lastFeishuTimestamp) {
      this.lastFeishuTimestamp = msg.timestamp;
      const userName = msg.userId || '飞书';
      // Inject Feishu message into Claude Code
      // Send Escape first to cancel any current input
      this.ptyProcess.write('\x1b');
      setTimeout(() => {
        this.ptyProcess?.write(`[飞书:${userName}] ${msg.text}\r`);
      }, 500);
    }
  }

  // ─── API helpers ───────────────────────────────────────────────────

  private async apiCall(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = `${this.options.apiUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiSecret) {
      headers['Authorization'] = `Bearer ${this.options.apiSecret}`;
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204 || res.status === 409) return null;
    if (!res.ok) {
      throw new Error(`API ${method} ${path}: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  private async sendFeishuEvent(type: string, state: CardState): Promise<void> {
    const payload = {
      type,
      botName: this.options.botName,
      chatId: this.options.chatId,
      state,
    };
    await this.apiCall('POST', `/bridge/events/${this.options.chatId}`, payload as Record<string, unknown>);
  }
}
