// src/logger.ts — 统一日志系统
// 记录 PTY 原始输出、解析结果、消息路由全过程

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = path.join(os.homedir(), '.shrimpbot', 'logs');
const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[37m',  // white
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

class Logger {
  private stream: fs.WriteStream | null = null;
  private level: LogLevel = 'info';
  private stderrEnabled = true; // 透传模式下关闭 stderr 输出，避免干扰 TUI

  constructor() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    // 支持环境变量设置日志级别
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    if (['debug', 'info', 'warn', 'error'].includes(envLevel)) {
      this.level = envLevel as LogLevel;
    }

    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `shrimpbot-${date}.log`);
    this.stream = fs.createWriteStream(logFile, { flags: 'a' });

    this.info('Logger', `日志文件: ${logFile} (级别: ${this.level})`);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setStderrEnabled(enabled: boolean): void {
    this.stderrEnabled = enabled;
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(level) >= order.indexOf(this.level);
  }

  private write(level: LogLevel, tag: string, message: string): void {
    if (!this.shouldLog(level)) return;

    const ts = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}`;

    // 文件
    this.stream?.write(line + '\n');

    // stderr（透传模式下关闭，避免干扰 Claude Code TUI）
    if (this.stderrEnabled) {
      const color = LOG_COLORS[level];
      console.error(`${color}${line}${RESET}`);
    }
  }

  debug(tag: string, message: string): void { this.write('debug', tag, message); }
  info(tag: string, message: string): void { this.write('info', tag, message); }
  warn(tag: string, message: string): void { this.write('warn', tag, message); }
  error(tag: string, message: string): void { this.write('error', tag, message); }

  /**
   * 记录 PTY 原始输出（用于调试 output-parser）
   */
  ptyRaw(data: string): void {
    if (!this.shouldLog('debug')) return;
    const ts = new Date().toISOString().slice(11, 19);
    // 转义不可见字符方便阅读
    const escaped = data
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    this.stream?.write(`[${ts}] [DEBUG] [PTY-RAW] ${escaped}\n`);
  }

  /**
   * 记录解析结果
   */
  parseResult(results: any[]): void {
    if (!this.shouldLog('debug')) return;
    const ts = new Date().toISOString().slice(11, 19);
    for (const r of results) {
      const summary = `type=${r.type} complete=${r.isComplete || false} yesNo=${r.isYesNo || false} text="${(r.text || '').slice(0, 80)}" options=${JSON.stringify(r.options || [])}`;
      this.stream?.write(`[${ts}] [DEBUG] [PARSE] ${summary}\n`);
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

// 全局单例
export const logger = new Logger();
