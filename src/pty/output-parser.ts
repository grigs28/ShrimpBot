import stripAnsi from 'strip-ansi';

// Claude Code TUI 输出解析器
// 只保留 Claude 的实际回复文本，过滤所有 TUI 渲染碎片

// Loading 动画字符
const LOADING_CHARS = new Set(['✶', '✻', '✽', '✢', '·', '*', '●']);

// 用户输入回显
const INPUT_ECHO = /^❯\s/;

// 分隔线
const SEPARATOR = /^─+$/;

// 状态栏（底部）
const STATUS_BAR = /^\[.*\].*│/;

// MCP 状态
const MCP_STATUS = /^\d+ MCP server/;

// 完成标记
const DONE_MARKER = '●';

// TUI 框架边框
const TUI_FRAME = /^[╭╰│]/;

// 进度条（██18%、░░ 等）
const PROGRESS_BAR = /[█░▓▒]{2,}/;

// TUI 控制提示碎片
const TUI_CONTROL = /shift\+tab|bypass permissions|ctrl\+o to expand/i;

// stop hook
const STOP_HOOK = /running stop hook/;

// Claude 状态动画词（Burrowing, Noodling, Moonwalking 等 TUI 瞬态显示）
const CLAUDE_STATUS_WORDS = /^(Burrowing|Noodling|Sprouting|Moonwalking|Meditating|Pondering|Cogitating|Reasoning|Analyzing|Processing|Searching|Reading|Writing|Thinking|Waiting|Loading|Running|Executing|Working|Downloading|Uploading)/i;

// 进度指标（token 计数、时间进度）
const PROGRESS_INDICATOR = /\d+\s*tokens?|\d+s\s*·|[↓↑]\s*\d/i;

// 工具执行标记（⎿ 前缀）
const TOOL_LINE = /^⎿\s/;

// 提示信息
const TIP_LINE = /^Tip:\s/i;

// thinking/thought 片段
const THINKING_FRAGMENT = /\(thinking\)|thought for \d+s?\)/i;

// TUI 重绘碎片（文字+箭头、部分状态词+数字、短字母数字混合）
const REDRAW_JUNK = /[↓↑]\d*$|[↓↑]$|\w{1,5}\d{2,}$/;

// 搜索/文件操作碎片
const SEARCH_FRAGMENT = /listing \d+ director/i;

// TUI 碎片过滤规则
const JUNK_PATTERNS = [
  /^[a-z0-9]{1,5}$/,        // 短 ASCII 碎片：n, tg, S3, p, wg62
  /^\d+%$/,                   // 纯百分比：18%
  /^██\s*\d*%?$/,            // 进度条：██18%
  /^\d+$/,                    // 纯数字：5, 8, 40
  /^\d+[a-z]+$/i,            // 数字+字母碎片：2ies, 3inking
  /^[a-z]+\d+$/i,            // 字母+数字碎片：wg62, uo34, r600
];

// Yes/No 权限确认（参考 claude-monitor）
const PERM_PATTERNS = [
  /requires approval/i, /do you want/i, /proceed/i,
  /\?\s*\[y\/n\]/i, /\?\s*\[Y\/n\]/, /\(yes\/no\)/i, /\(y\/n\)/i,
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

      if (INPUT_ECHO.test(trimmed)) {
        this.isWaitingInput = true;
        continue;
      }

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
          if (this.recentLines.length > 10) this.recentLines.shift();
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

    // ===== TUI 过滤（所有 TUI 渲染碎片） =====

    // 框架边框
    if (SEPARATOR.test(line)) return null;
    if (STATUS_BAR.test(line)) return null;
    if (MCP_STATUS.test(line)) return null;
    if (TUI_FRAME.test(line)) return null;

    // 进度条
    if (PROGRESS_BAR.test(line)) return null;

    // TUI 控制提示
    if (TUI_CONTROL.test(line)) return null;

    // stop hook
    if (STOP_HOOK.test(line)) return null;

    // Claude 状态动画词（Burrowing, Noodling 等）
    if (CLAUDE_STATUS_WORDS.test(line)) return null;

    // 进度指标（token 计数、时间）
    if (PROGRESS_INDICATOR.test(line)) return null;

    // 工具执行标记（⎿ 前缀）
    if (TOOL_LINE.test(line)) return null;

    // 提示信息
    if (TIP_LINE.test(line)) return null;

    // thinking/thought 片段
    if (THINKING_FRAGMENT.test(line)) return null;

    // TUI 重绘碎片
    if (REDRAW_JUNK.test(line)) return null;

    // 搜索/文件操作碎片
    if (SEARCH_FRAGMENT.test(line)) return null;

    // TUI 短碎片
    if (JUNK_PATTERNS.some(p => p.test(line))) return null;

    // ===== 有意义内容检测 =====

    // 去掉开头 loading 字符
    let text = line;
    if (LOADING_CHARS.has(text[0]!) && text.length > 1) {
      text = text.slice(1);
    }
    text = text.trim();
    if (!text) return null;

    // 最低文本门槛：纯 ASCII ≥8 字符 或 含中文
    const hasChinese = /[\u4e00-\u9fff]/.test(text);
    const isSubstantial = text.length >= 8 || hasChinese;
    if (!isSubstantial) return null;

    // 选项行检测
    const optMatch = text.match(OPTION_PATTERN)
      || text.match(OPTION_ALT_PATTERNS[0])!
      || text.match(OPTION_ALT_PATTERNS[1]);
    if (optMatch && optMatch[2]) {
      return { type: 'question', text: optMatch[2].trim(), isComplete: true, options: [optMatch[2].trim()] };
    }

    // ● 完成标记
    if (text.startsWith(DONE_MARKER)) {
      const cleanText = this.cleanResponseText(text.slice(1).trim());
      if (!cleanText) return null;

      const optM = cleanText.match(OPTION_PATTERN);
      if (optM) {
        return { type: 'question', text: optM[2]!.trim(), isComplete: true, options: [optM[2]!.trim()] };
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

    // 流式文本累积
    const lastLine = this.responseLines.length > 0
      ? this.responseLines[this.responseLines.length - 1]! : '';
    if (lastLine && (text.startsWith(lastLine) || lastLine.startsWith(text))) {
      // 同一行更新（TUI 重绘）：保留更长的版本
      this.responseLines[this.responseLines.length - 1] = text.length > lastLine.length ? text : lastLine;
    } else {
      this.responseLines.push(text);
    }
    this.accumulatedText = this.responseLines.join('\n');

    // 包含 ● → 回复完成
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

  /**
   * 清理回复文本尾部的 TUI 状态碎片
   */
  private cleanResponseText(text: string): string {
    return text
      .replace(/\s*·\s*Noodling[^"]*$/, '')
      .replace(/\s*·\s*\w+\.\.\..*$/, '')
      .replace(/\s*\d+s\s*·\s*[↓↑]\s*\d+.*$/, '') // "30s · ↓ 379 tokens" 尾部
      .replace(/\s*ctrl\+o to expand.*$/i, '')
      .trim();
  }

  markNewRound(): void { this.pendingReset = true; }
  getIsWaitingInput(): boolean { return this.isWaitingInput; }
  getLastComplete(): string { return this.lastCompleteText; }
  getAccumulated(): string { return this.accumulatedText; }
  getRecentLines(): string[] { return [...this.recentLines]; }

  reset(): void {
    this.accumulatedText = '';
    this.responseLines = [];
    this.lastCompleteText = '';
    this.recentLines = [];
    this.isWaitingInput = false;
    this.pendingReset = false;
  }
}
