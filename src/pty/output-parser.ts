import { ptyToText } from 'ghostty-opentui';

// Claude Code TUI 输出解析器
// 使用 ghostty-opentui 终端引擎解析 PTY 输出
// TODO: 待 @xterm/headless 修复 Node.js v24 兼容后切换

// 完成标记
const DONE_MARKER = '●';

// 用户输入行
const INPUT_ECHO = /^❯\s/;

// 分隔线
const SEPARATOR = /^[─╴╶╵╷╸╺╻╼╽╾╿═\-]+$/;

// Claude 状态动画（通用匹配：符号前缀 + 动词 + …）
const CLAUDE_STATUS = /^[✻✽✢✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋⏵⏷⏸⏹⏺✓✕✖✗✘✙✚✛✜✝✞✟✠✡✦✧\*\+·•○◎◙►◄↕‼]/;
const STATUS_FRAGMENT = /\w+\s*\w*\s*…/;

// 进度指标
const PROGRESS = /\d+\s*tokens?|\d+s?\s*·|[↓↑]\s*\d|Context\s*[█░]+|█{2,}|░{2,}/i;

// 工具行
const TOOL_LINE = /^⎿\s/;

// TUI 元素
const TUI_BORDER = /^[╭╮╰╯│┃┤├┬┴┼─━═┌┐└┘├┤┬┴┼│]+/;
const TABLE_ROW = /^[╭╮╰╯│┃┤├┬┴┼─━═┌┐└┘├┤┬┴┼│\s]+$/;
const MODEL_BAR = /^\[.*\]\s*[│|]/;
const VERSION_BAR = /Claude Code v\d/i;
const EFFORT = /^●\s*(high|medium|low)\s*·\s*\/effort/i;
const TUI_CONTROL = /shift\+tab|bypass permissions|ctrl\+o to expand/i;
const TUI_INDICATOR = /^\d+\s+\w+.*·\s*\//;
const TUI_PATH = /^\w{1,5}\s*·\s*\//;
const SEARCH = /listing|listed\s*\d+\s*director|searched for \d+ pattern/i;
const ERROR_LINE = /^\[error\]/i;
const TIP = /^Tip:\s/i;
const THINKING = /\(thinking\)|thought for \d+s?\)|Brewed for \d+s/i;

const JUNK = [
  /^[a-z0-9]{1,5}$/,
  /^\d+%$/,
  /^\d+$/,
  /^h\s*[·•]/i,
];

export interface ParsedOutput {
  type: 'response' | 'question' | 'loading' | 'ignore';
  text: string;
  isComplete: boolean;
  isYesNo?: boolean;
  options?: string[];
}

export class OutputParser {
  private responseLines: string[] = [];
  private accumulatedText = '';
  private lastCompleteText = '';
  private pendingReset = false;

  parse(rawData: string): ParsedOutput[] {
    if (this.pendingReset) {
      this.responseLines = [];
      this.accumulatedText = '';
      this.pendingReset = false;
    }

    const clean = ptyToText(rawData, { cols: 120, rows: 40 });
    const results: ParsedOutput[] = [];
    const lines = clean.split(/\r?\n/);

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (INPUT_ECHO.test(t) || SEPARATOR.test(t)) continue;
      const parsed = this.parseLine(t);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  private parseLine(line: string): ParsedOutput | null {
    // ● 完成标记优先
    if (line.startsWith(DONE_MARKER)) {
      const text = this.cleanText(line.slice(1).trim());
      if (!text) return null;
      this.lastCompleteText = text;
      this.responseLines = [];
      this.accumulatedText = '';
      return { type: 'response', text, isComplete: true };
    }

    // TUI 过滤
    if (SEPARATOR.test(line)) return null;
    if (CLAUDE_STATUS.test(line)) return null;
    if (STATUS_FRAGMENT.test(line) && line.length < 60) return null;
    if (PROGRESS.test(line)) return null;
    if (TOOL_LINE.test(line)) return null;
    if (TUI_BORDER.test(line)) return null;
    if (TABLE_ROW.test(line)) return null;
    if (MODEL_BAR.test(line)) return null;
    if (VERSION_BAR.test(line)) return null;
    if (EFFORT.test(line)) return null;
    if (TUI_CONTROL.test(line)) return null;
    if (TUI_INDICATOR.test(line)) return null;
    if (TUI_PATH.test(line)) return null;
    if (SEARCH.test(line)) return null;
    if (ERROR_LINE.test(line)) return null;
    if (TIP.test(line)) return null;
    if (THINKING.test(line)) return null;
    if (JUNK.some(p => p.test(line))) return null;

    const text = line.trim();
    if (!text) return null;
    const hasChinese = /[\u4e00-\u9fff]/.test(text);
    if (text.length < 6 && !hasChinese) return null;

    // 流式累积
    const last = this.responseLines.length > 0 ? this.responseLines[this.responseLines.length - 1]! : '';
    if (last && (text.startsWith(last) || last.startsWith(text))) {
      this.responseLines[this.responseLines.length - 1] = text.length > last.length ? text : last;
    } else {
      this.responseLines.push(text);
    }
    this.accumulatedText = this.responseLines.join('\n');

    if (text.includes(DONE_MARKER)) {
      const full = this.accumulatedText.replace(/●/g, '').trim();
      if (full) {
        this.lastCompleteText = full;
        this.responseLines = [];
        this.accumulatedText = '';
        return { type: 'response', text: full, isComplete: true };
      }
    }

    return { type: 'response', text: this.accumulatedText, isComplete: false };
  }

  private cleanText(text: string): string {
    if (/^(high|medium|low)\s*·\s*\/effort/i.test(text)) return '';
    return text
      .replace(/\s*·\s*\w+\.{2,}.*$/, '')
      .replace(/\s*\d+s\s*·\s*[↓↑]\s*\d+.*$/, '')
      .replace(/\s*ctrl\+o to expand.*$/i, '')
      .trim();
  }

  // headless 接口（当前用 ghostty-opentui，未来可切换到 xterm headless）
  write(_data: string): void { /* ghostty 是无状态的，parse 时处理 */ }
  extractLines(): string[] {
    return this.accumulatedText ? this.accumulatedText.split('\n') : [];
  }
  getBufferText(): string { return this.accumulatedText || this.lastCompleteText; }
  hasNewContent(): boolean { return true; }
  getLastLine(): string {
    const lines = this.extractLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim()) return lines[i]!.trim();
    }
    return '';
  }
  getFullContent(): string { return this.getBufferText(); }
  getCols(): number { return 120; }
  getRows(): number { return 40; }
  resize(_cols: number, _rows: number): void {}
  reset(): void {
    this.responseLines = [];
    this.accumulatedText = '';
    this.lastCompleteText = '';
    this.pendingReset = false;
  }
  markNewRound(): void { this.pendingReset = true; }
  getIsWaitingInput(): boolean { return false; }
  getLastComplete(): string { return this.lastCompleteText; }
  getAccumulated(): string { return this.accumulatedText; }
  getRecentLines(): string[] { return this.responseLines.slice(-10); }
}
