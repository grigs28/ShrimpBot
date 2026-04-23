import { spawn, type IPty } from 'node-pty';
import { OutputParser } from './output-parser.js';
import { logger } from '../logger.js';

export interface PTYOptions {
  claudePath?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  extraArgs?: string[];
  /** bot 名称，用于日志标识 */
  botName?: string;
  /** 是否自动重启（默认 true） */
  autoRestart?: boolean;
}

export type PTYEvent =
  | { type: 'response'; text: string; isComplete: boolean; isYesNo?: boolean }
  | { type: 'question'; options: string[] }
  | { type: 'exit'; code: number }
  | { type: 'error'; error: Error };

export class PTYManager {
  private pty: IPty | null = null;
  private parser: OutputParser;
  private listeners: ((event: PTYEvent) => void)[] = [];
  private rawListeners: ((data: string) => void)[] = [];
  private running = false;
  private tag: string;
  private stopped = false;
  private restartCount = 0;
  private readonly MAX_RESTARTS = 5;
  private readonly RESTART_WINDOW_MS = 60000;
  private restartHistory: number[] = [];

  constructor(private options: PTYOptions = {}) {
    this.parser = new OutputParser();
    this.tag = `PTY:${options.botName || 'default'}`;
  }

  start(): void {
    if (this.pty) {
      throw new Error('PTY already running');
    }

    const claudePath = this.options.claudePath || 'claude';
    // extraArgs 去重（防止 --dangerously-skip-permissions 重复）
    const baseArgs = ['--dangerously-skip-permissions'];
    const extraArgs = (this.options.extraArgs || []).filter(
      a => !baseArgs.includes(a)
    );
    const args = [...baseArgs, ...extraArgs];

    const cols = this.options.cols || 120;
    const rows = this.options.rows || 40;

    this.pty = spawn(claudePath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.options.cwd || process.cwd(),
      env: process.env as Record<string, string>,
    });

    this.running = true;
    logger.info(this.tag, `启动: claude ${args.join(' ')} (cwd: ${this.options.cwd || process.cwd()}, ${cols}x${rows})`);

    let dataCount = 0;
    this.pty.onData((data: string) => {
      dataCount++;
      if (dataCount <= 5 || dataCount % 100 === 0) {
        logger.debug(this.tag, ` onData #${dataCount}: ${data.length}字节`);
      }

      // 1. 通知原始数据监听器（透传模式 + Web 广播）
      for (const cb of this.rawListeners) {
        try { cb(data); } catch (_) { /* ignore */ }
      }

      // 2. 解析提取有意义内容（飞书用）
      const results = this.parser.parse(data);

      if (results.length > 0) {
        logger.debug(this.tag, `解析到 ${results.length} 条输出`);
      }

      for (const result of results) {
        if (result.type === 'response' && result.text) {
          logger.debug(this.tag, `→ response: complete=${result.isComplete} "${result.text.slice(0, 80)}"`);
          this.emit({ type: 'response', text: result.text, isComplete: result.isComplete, isYesNo: result.isYesNo });
        } else if (result.type === 'question') {
          logger.debug(this.tag, `→ question: options=${JSON.stringify(result.options)}`);
          this.emit({ type: 'question', options: result.options || [] });
        }
      }
    });

    this.pty.onExit(({ exitCode }) => {
      this.running = false;
      logger.info(this.tag, `退出: code=${exitCode}`);
      this.emit({ type: 'exit', code: exitCode });
      this.pty = null;

      if (this.options.autoRestart !== false && !this.stopped) {
        this.scheduleRestart();
      }
    });
  }

  send(message: string): void {
    if (!this.pty || !this.running) {
      throw new Error('PTY not running');
    }
    this.parser.markNewRound();
    this.pty.write(message + '\r');
    logger.info(this.tag, `← 发送: "${message.slice(0, 100)}"`);
  }

  /** 重置 parser 并写入文本（不带 \r），回车由调用方延迟单独发送 */
  resetAndWrite(text: string): void {
    if (!this.pty || !this.running) return;
    this.parser.markNewRound();
    this.pty.write(text);
    logger.info(this.tag, `← 写入文本: "${text.slice(0, 100)}"`);
  }

  onEvent(listener: (event: PTYEvent) => void): void {
    this.listeners.push(listener);
  }

  /** 监听 PTY 原始输出（透传 + Web 广播） */
  onRawData(callback: (data: string) => void): void {
    this.rawListeners.push(callback);
  }

  /** 直接写入 PTY（透传模式） */
  writeRaw(data: string): void {
    if (this.pty && this.running) {
      logger.info(this.tag, `← writeRaw: ${JSON.stringify(data)}`);
      this.pty.write(data);
    }
  }

  /** 调整 PTY + headless 终端大小 */
  resize(cols: number, rows: number): void {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
    this.parser.resize(cols, rows);
  }

  /** 获取终端缓冲区文本（Web API 用） */
  getBufferText(): string {
    return this.parser.getBufferText();
  }

  /** 获取终端尺寸 */
  getTerminalSize(): { cols: number; rows: number } {
    return { cols: this.parser.getCols(), rows: this.parser.getRows() };
  }

  private emit(event: PTYEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error(this.tag, `事件监听器错误: ${err}`);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter(t => now - t < this.RESTART_WINDOW_MS);

    if (this.restartHistory.length >= this.MAX_RESTARTS) {
      logger.error(this.tag, `重启次数过多（${this.MAX_RESTARTS}次/${this.RESTART_WINDOW_MS / 1000}秒），放弃自动恢复`);
      this.emit({ type: 'error', error: new Error('Max restarts exceeded') });
      return;
    }

    this.restartHistory.push(now);
    const delay = Math.min(3000 * (this.restartHistory.length), 15000);
    logger.info(this.tag, `将在 ${delay / 1000} 秒后自动重启 (${this.restartHistory.length}/${this.MAX_RESTARTS})`);

    setTimeout(() => {
      if (this.stopped) return;
      try {
        this.parser.reset();
        this.start();
        logger.info(this.tag, '自动重启成功');
      } catch (err) {
        logger.error(this.tag, `自动重启失败: ${err}`);
      }
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
    this.running = false;
    logger.info(this.tag, '已停止');
  }
}
