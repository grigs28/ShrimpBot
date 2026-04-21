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
  private stopped = false; // 用户主动停止
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
    const args = ['--dangerously-skip-permissions', ...(this.options.extraArgs || [])];

    this.pty = spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: this.options.cols || 120,
      rows: this.options.rows || 40,
      cwd: this.options.cwd || process.cwd(),
      env: process.env as Record<string, string>,
    });

    this.running = true;
    logger.info(this.tag, `启动: claude ${args.join(' ')} (cwd: ${this.options.cwd || process.cwd()})`);

    this.pty.onData((data: string) => {
      // 通知原始数据监听器（用于透传模式）
      for (const cb of this.rawListeners) {
        try { cb(data); } catch (_) { /* ignore */ }
      }

      // 记录 PTY 原始输出
      logger.ptyRaw(data);

      const results = this.parser.parse(data);

      // 记录解析结果
      if (results.length > 0) {
        logger.parseResult(results);
      }

      for (const result of results) {
        if (result.type === 'response' && result.text) {
          logger.debug(this.tag, `→ response: complete=${result.isComplete} yesNo=${result.isYesNo || false} "${result.text.slice(0, 80)}"`);
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

      // 自动重启（非用户主动停止时）
      if (this.options.autoRestart !== false && !this.stopped) {
        this.scheduleRestart();
      }
    });
  }

  send(message: string): void {
    if (!this.pty || !this.running) {
      throw new Error('PTY not running');
    }
    // 延迟 reset：标记新一轮，第一个 chunk 到来时清理旧状态
    // 避免立即 reset 导致残留输出被误解析
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

  /** 监听 PTY 原始输出（用于透传到终端） */
  onRawData(callback: (data: string) => void): void {
    this.rawListeners.push(callback);
  }

  /** 直接写入 PTY（不做 parser reset，用于透传模式） */
  writeRaw(data: string): void {
    if (this.pty && this.running) {
      this.pty.write(data);
    }
  }

  /** 调整 PTY 终端大小 */
  resize(cols: number, rows: number): void {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
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
    const delay = Math.min(3000 * (this.restartHistory.length), 15000); // 指数退避，最大15秒
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
