import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { StreamJSONParser, type ParsedEvent } from './stream-json-parser.js';
import { TerminalUI } from './terminal-ui.js';
import type { CardState, ToolCall } from '../types.js';

export interface BridgeOptions {
  chatId: string;
  botName: string;
  apiUrl: string;
  apiSecret?: string;
  workingDirectory?: string;
  sessionId?: string;
}

interface FeishuEventPayload {
  type: 'initial' | 'update' | 'complete' | 'terminal_input';
  botName: string;
  chatId: string;
  state: CardState;
  messageId?: string;
}

interface FeishuMessage {
  userName: string;
  text: string;
}

export class CLIBridge {
  private claudeProcess?: ChildProcess;
  private parser = new StreamJSONParser();
  private terminal = new TerminalUI();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private pollInterval?: ReturnType<typeof setInterval>;
  private rl?: readline.Interface;
  private messageId?: string;
  private accumulatedText = '';
  private currentTools: ToolCall[] = [];
  private currentStatus: CardState['status'] = 'thinking';
  private userPrompt = '';

  constructor(private options: BridgeOptions) {}

  async start(): Promise<void> {
    // 1. Register with ShrimpBot
    const registerRes = await this.apiCall('POST', '/bridge/register', {
      chatId: this.options.chatId,
    });
    if (registerRes === null) {
      this.terminal.showError(
        `Failed to register chatId ${this.options.chatId} (409 conflict or error). Exiting.`,
      );
      process.exit(1);
    }

    // 2. Spawn claude process
    const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (this.options.sessionId) {
      args.push('--resume', this.options.sessionId);
    }
    this.claudeProcess = spawn('claude', args, {
      cwd: this.options.workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // 3. Attach StreamJSONParser handlers
    this.parser.onEvent((event) => this.handleParsedEvent(event));
    this.parser.start(this.claudeProcess);

    // 4. Heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.apiCall('POST', '/bridge/heartbeat', { chatId: this.options.chatId }).catch(() => {
        // ignore heartbeat errors
      });
    }, 10000);

    // 5. Poll Feishu messages
    this.pollInterval = setInterval(() => {
      this.pollMessages().catch(() => {
        // ignore poll errors
      });
    }, 500);

    // 6. Terminal input
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '',
    });
    this.rl.on('line', (line) => {
      this.handleTerminalInput(line);
    });

    // 7. On claude exit
    this.claudeProcess.on('exit', (code) => {
      this.terminal.showStatus(`Claude process exited with code ${code ?? 'unknown'}`);
      this.cleanup().then(() => process.exit(0));
    });

    this.terminal.showStatus('CLIBridge started. Waiting for events...');
  }

  async cleanup(): Promise<void> {
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
    if (this.claudeProcess) {
      this.claudeProcess.kill();
      this.claudeProcess = undefined;
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.options.apiSecret) {
      headers['Authorization'] = `Bearer ${this.options.apiSecret}`;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204 || res.status === 409) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed: ${res.status} ${res.statusText}`);
    }

    return res.json();
  }

  private async sendFeishuEvent(type: FeishuEventPayload['type'], state: CardState): Promise<void> {
    const payload: FeishuEventPayload = {
      type,
      botName: this.options.botName,
      chatId: this.options.chatId,
      state,
      messageId: this.messageId,
    };
    const res = await this.apiCall('POST', `/bridge/events/${this.options.chatId}`, payload as unknown as Record<string, unknown>);
    if (type === 'initial' && res && typeof res.messageId === 'string') {
      this.messageId = res.messageId;
    }
  }

  private handleParsedEvent(event: ParsedEvent): void {
    switch (event.type) {
      case 'system': {
        if (event.sessionId) {
          this.terminal.showSessionInfo(event.sessionId);
        }
        break;
      }

      case 'assistant_text': {
        if (event.text) {
          this.accumulatedText += event.text;
          this.terminal.showClaudeText(event.text);
        }
        this.sendUpdateEvent();
        break;
      }

      case 'assistant_tool_use': {
        const detail = this.formatToolDetail(event.toolName, event.toolInput);
        this.terminal.showToolCall(event.toolName || 'tool', detail);
        this.currentTools.push({
          name: event.toolName || 'tool',
          detail: detail || '',
          status: 'running',
        });
        this.currentStatus = 'running';
        this.sendUpdateEvent();
        break;
      }

      case 'tool_result': {
        this.terminal.showToolDone();
        // Mark the last running tool as done
        for (let i = this.currentTools.length - 1; i >= 0; i--) {
          if (this.currentTools[i].status === 'running') {
            this.currentTools[i].status = 'done';
            break;
          }
        }
        this.sendUpdateEvent();
        break;
      }

      case 'stream_delta': {
        if (event.text) {
          this.accumulatedText += event.text;
          this.terminal.showStreamDelta(event.text);
        }
        this.sendUpdateEvent();
        break;
      }

      case 'result': {
        this.terminal.showResult(
          event.resultText || this.accumulatedText,
          event.costUsd,
          event.durationMs,
        );
        const finalState: CardState = {
          status: event.isError ? 'error' : 'complete',
          userPrompt: this.userPrompt,
          responseText: event.resultText || this.accumulatedText,
          toolCalls: this.currentTools.map((t) => ({ ...t, status: 'done' })),
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          errorMessage: event.isError ? (event.resultText || 'Unknown error') : undefined,
        };
        this.sendFeishuEvent('complete', finalState).catch(() => {});
        break;
      }

      default: {
        // Ignore unknown events
        break;
      }
    }
  }

  private sendUpdateEvent(): void {
    const state: CardState = {
      status: this.currentStatus,
      userPrompt: this.userPrompt,
      responseText: this.accumulatedText,
      toolCalls: [...this.currentTools],
    };
    this.sendFeishuEvent('update', state).catch(() => {});
  }

  private async pollMessages(): Promise<void> {
    const messages = await this.apiCall('GET', `/bridge/messages/${this.options.chatId}`);
    if (!Array.isArray(messages)) {
      return;
    }
    for (const msg of messages as FeishuMessage[]) {
      if (msg.text) {
        this.terminal.showFeishuMessage(msg.userName || 'User', msg.text);
        this.writeToClaudeStdin(msg.text);
      }
    }
  }

  private handleTerminalInput(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.terminal.showTerminalInput(trimmed);
    this.writeToClaudeStdin(trimmed);

    // Notify Feishu about terminal input
    const state: CardState = {
      status: 'waiting_for_input',
      userPrompt: this.userPrompt,
      responseText: this.accumulatedText,
      toolCalls: [...this.currentTools],
    };
    this.sendFeishuEvent('terminal_input', state).catch(() => {});
  }

  private writeToClaudeStdin(text: string): void {
    if (this.claudeProcess?.stdin?.writable) {
      this.claudeProcess.stdin.write(text + '\n');
    }
  }

  private formatToolDetail(toolName?: string, toolInput?: unknown): string {
    if (!toolInput || typeof toolInput !== 'object') {
      return '';
    }
    const input = toolInput as Record<string, unknown>;

    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit': {
        const filePath = typeof input.file_path === 'string' ? input.file_path : '';
        if (!filePath) return '';
        const parts = filePath.split('/');
        const short = parts.slice(-2).join('/');
        return short;
      }
      case 'Bash': {
        const command = typeof input.command === 'string' ? input.command : '';
        if (!command) return '';
        return command.length > 60 ? command.slice(0, 60) + '...' : command;
      }
      case 'Grep':
      case 'Glob': {
        const pattern = typeof input.pattern === 'string' ? input.pattern : '';
        return pattern;
      }
      default: {
        // Try common fields
        if (typeof input.file_path === 'string') {
          const parts = input.file_path.split('/');
          return parts.slice(-2).join('/');
        }
        if (typeof input.command === 'string') {
          return input.command.length > 60 ? input.command.slice(0, 60) + '...' : input.command;
        }
        if (typeof input.pattern === 'string') {
          return input.pattern;
        }
        return '';
      }
    }
  }
}
