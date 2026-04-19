import * as readline from 'node:readline';
import { TerminalUI } from './terminal-ui.js';
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
 * CLIBridge — pure message relay between Feishu and the terminal.
 *
 * Does NOT spawn Claude Code. Instead, it:
 * 1. Registers with ShrimpBot API for a specific chatId
 * 2. Polls for Feishu messages → prints them in terminal (user copies to claude)
 * 3. Reads terminal input → forwards to Feishu as "[终端]" messages
 *
 * Usage: user runs `claude` in one terminal, `shrimpbot-bridge` in another.
 * The bridge keeps both sides in sync.
 */
export class CLIBridge {
  private terminal = new TerminalUI();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private rl?: readline.Interface;
  private running = false;

  constructor(private options: BridgeOptions) {}

  async start(): Promise<void> {
    // 1. Register with ShrimpBot
    const registerRes = await this.apiCall('POST', '/bridge/register', {
      chatId: this.options.chatId,
    });
    if (registerRes === null) {
      this.terminal.showError(
        `注册失败：chatId ${this.options.chatId} 已被其他 bridge 绑定或 API 错误`,
      );
      process.exit(1);
    }
    this.terminal.showStatus(`已绑定 chatId: ${this.options.chatId}`);

    // 2. Send initial card to Feishu
    const initialState: CardState = {
      status: 'running',
      userPrompt: 'Bridge 已连接',
      responseText: '终端 Bridge 已启动，等待消息...',
      toolCalls: [],
    };
    await this.sendFeishuEvent('initial', initialState);

    // 3. Heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.apiCall('POST', '/bridge/heartbeat', { chatId: this.options.chatId }).catch(() => {});
    }, 10_000);

    // 4. Poll Feishu messages
    this.running = true;
    this.pollInterval = setInterval(() => {
      this.pollMessages().catch(() => {});
    }, 500);

    // 5. Terminal input → forward to Feishu
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
    });
    this.rl.on('line', (line) => {
      this.handleTerminalInput(line);
    });

    this.terminal.showStatus('Bridge 已启动。飞书消息会显示在这里。');
    this.terminal.showStatus('输入文字按回车，消息会转发到飞书。');
    this.terminal.showStatus('按 Ctrl+C 退出。');
    this.terminal.showStatus('---');
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
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
    await this.apiCall('POST', '/bridge/unregister', {
      chatId: this.options.chatId,
    });
  }

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

  private async pollMessages(): Promise<void> {
    if (!this.running) return;
    const msg = await this.apiCall('GET', `/bridge/messages/${this.options.chatId}`);
    if (msg && msg.text) {
      this.terminal.showFeishuMessage(msg.userId || '飞书用户', msg.text);
    }
  }

  private handleTerminalInput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !this.running) return;

    this.terminal.showTerminalInput(trimmed);

    // Forward terminal input to Feishu
    this.apiCall('POST', `/bridge/events/${this.options.chatId}`, {
      type: 'terminal_input',
      botName: this.options.botName,
      text: trimmed,
    }).catch(() => {});
  }
}
