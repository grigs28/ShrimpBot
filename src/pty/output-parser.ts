import stripAnsi from 'strip-ansi';

// Claude Code TUI 输出解析器
// 所有内容（包括状态文字）都通过，只过滤 TUI 框架元素

// Loading 动画字符（单个旋转字符，不作为独立内容）
const LOADING_CHARS = new Set(['✶', '✻', '✽', '✢', '·', '*', '●']);

// 用户输入回显
const INPUT_ECHO = /^❯\s/;

// 分隔线
const SEPARATOR = /^─+$/;

// 状态栏（底部状态栏，如 [model] xxx │ tokens）
const STATUS_BAR = /^\[.*\].*│/;

// MCP 状态
const MCP_STATUS = /^\d+ MCP server/;

// 完成标记
const DONE_MARKER = '●';

// TUI 框架边框
const TUI_FRAME = /^[╭╰│]/;

// Context 进度条
const CONTEXT_BAR = /Context.*░/;

// stop hook 输出
const STOP_HOOK = /running stop hook/;

// 纯 TUI 控制字符/短碎片（不超过 3 个 ASCII 字符的碎片）
const SHORT_ASCII_JUNK = /^[a-z0-9]{1,3}$/;

// Yes/No 权限确认（参考 claude-monitor：prompt + options 同时存在）
const PERM_PATTERNS = [
  /requires approval/i,
  /do you want/i,
  /proceed/i,
  /\?\s*\[y\/n\]/i,
  /\?\s*\[Y\/n\]/,
  /\(yes\/no\)/i,
  /\(y\/n\)/i,
];
const PERM_OPTION_YES = /\byes\b/i;
const PERM_OPTION_NO = /\bno\b/i;
const PERM_OPTION_ALWAYS = [/\balways\b/i, /don'?t ask/i];

// 选项模式
const OPTION_PATTERN = /^\s*(\d{1,2})\.\s*(.{1,50})$/;
const OPTION_ALT_PATTERNS = [
  /^\s*(\d{1,2})[)]\s*(.{1,50})$/,
  /^\s*[(（](\d{1,2})[)）]\s*(.{1,50})$/,
];

export interface ParsedOutput {
  type: 'response' | 'question' | 'loading' | 'ignore';
  text: string;
  isComplete: boolean;
  isYesNo?: boolean;
  options?: string[];
}

export class OutputParser {
  private accumulatedText = '';
  private lastCompleteText = '';
  private recentLines: string[] = [];
  private isWaitingInput = false;
  private pendingReset = false;
  private responseLines: string[] = [];

  parse(rawData: string): ParsedOutput[] {
    if (this.pendingReset) {
      this.accumulatedText = '';
      this.responseLines = [];
      this.recentLines = [];
      this.isWaitingInput = false;
      this.pendingReset = false;
    }

    const clean = stripAnsi(rawData);
    const results: ParsedOutput[] = [];

    const lines = clean.split(/\r\r?\n?/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 输入提示符 → 本轮结束
      if (INPUT_ECHO.test(trimmed)) {
        this.isWaitingInput = true;
        continue;
      }

      // 分隔线 → 新一轮开始，清空累积
      if (SEPARATOR.test(trimmed)) {
        this.isWaitingInput = false;
        this.accumulatedText = '';
        this.responseLines = [];
        continue;
      }

      const parsed = this.parseLine(trimmed);
      if (parsed) {
        results.push(parsed);
        if (parsed.type === 'response') {
          this.recentLines.push(parsed.text);
          if (this.recentLines.length > 10) {
            this.recentLines.shift();
          }
        }
      }
    }

    return results;
  }

  private parseLine(line: string): ParsedOutput | null {
    // 纯 loading 动画（单个旋转字符）→ 忽略
    if (line.length <= 2 && LOADING_CHARS.has(line)) {
      return { type: 'loading', text: '', isComplete: false };
    }

    // TUI 框架元素 → 忽略
    if (SEPARATOR.test(line)) return null;
    if (STATUS_BAR.test(line)) return null;
    if (MCP_STATUS.test(line)) return null;
    if (TUI_FRAME.test(line)) return null;
    if (CONTEXT_BAR.test(line)) return null;

    // stop hook → 忽略
    if (STOP_HOOK.test(line)) return null;

    // 短 ASCII 碎片 → 忽略
    if (SHORT_ASCII_JUNK.test(line)) return null;

    // 去掉开头 loading 字符
    let text = line;
    if (LOADING_CHARS.has(text[0]!) && text.length > 1) {
      text = text.slice(1);
    }
    text = text.trim();
    if (!text) return null;

    // 选项行检测
    const optMatch = text.match(OPTION_PATTERN)
      || text.match(OPTION_ALT_PATTERNS[0])!
      || text.match(OPTION_ALT_PATTERNS[1]);
    if (optMatch && optMatch[2]) {
      return {
        type: 'question',
        text: optMatch[2].trim(),
        isComplete: true,
        options: [optMatch[2].trim()],
      };
    }

    // ● 完成标记
    if (text.startsWith(DONE_MARKER)) {
      const cleanText = text.slice(1).trim();
      if (!cleanText) return null;

      // 检查 ● 后是否是选项
      const optM = cleanText.match(OPTION_PATTERN);
      if (optM) {
        return {
          type: 'question',
          text: optM[2]!.trim(),
          isComplete: true,
          options: [optM[2]!.trim()],
        };
      }

      this.lastCompleteText = cleanText;
      this.accumulatedText = '';
      this.responseLines = [];
      this.isWaitingInput = true;

      const hasPermPrompt = PERM_PATTERNS.some(p => p.test(cleanText));
      const hasYes = PERM_OPTION_YES.test(cleanText);
      const hasNo = PERM_OPTION_NO.test(cleanText);
      const hasAlways = PERM_OPTION_ALWAYS.some(p => p.test(cleanText));
      const isYesNo = hasPermPrompt && ((hasYes && hasNo) || hasAlways);

      return { type: 'response', text: cleanText, isComplete: true, isYesNo };
    }

    // 流式文本：所有非框架内容都累积
    const lastLine = this.responseLines.length > 0
      ? this.responseLines[this.responseLines.length - 1]! : '';
    if (lastLine && (text.startsWith(lastLine) || lastLine.startsWith(text))) {
      // 同一行更新（TUI 重绘）
      this.responseLines[this.responseLines.length - 1] = text.length > lastLine.length ? text : lastLine;
    } else {
      this.responseLines.push(text);
    }
    this.accumulatedText = this.responseLines.join('\n');

    // 如果包含 ● 标记 → 回复完成
    if (text.includes(DONE_MARKER)) {
      const fullText = this.accumulatedText.replace(/●/g, '').trim();
      if (fullText) {
        this.lastCompleteText = fullText;
        this.accumulatedText = '';
        this.responseLines = [];
        this.isWaitingInput = true;
        return { type: 'response', text: fullText, isComplete: true };
      }
    }

    return { type: 'response', text: this.accumulatedText, isComplete: false };
  }

  markNewRound(): void {
    this.pendingReset = true;
  }

  getIsWaitingInput(): boolean {
    return this.isWaitingInput;
  }

  getLastComplete(): string {
    return this.lastCompleteText;
  }

  getAccumulated(): string {
    return this.accumulatedText;
  }

  getRecentLines(): string[] {
    return [...this.recentLines];
  }

  reset(): void {
    this.accumulatedText = '';
    this.responseLines = [];
    this.lastCompleteText = '';
    this.recentLines = [];
    this.isWaitingInput = false;
    this.pendingReset = false;
  }
}
