import { ptyToText } from 'ghostty-opentui';

// Claude Code TUI 输出解析器
// 使用 ghostty-opentui 终端引擎解析 PTY 输出
// TODO: 待 @xterm/headless 修复 Node.js v24 兼容后切换

// 完成标记
const DONE_MARKER = '●';

// 用户输入行
const INPUT_ECHO = /^❯(?:\s|$)/;

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
// 纯边框行（只有框线字符，无内容）
const PURE_BORDER = /^[╭╮╰╯├┤┬┴┼─━═┌┐└┘]+$/;
// TUI 边框行（行首是边框字符，用于过滤标题行）
const TUI_BORDER_START = /^[╭╮╰╯├┤┬┴┼─━═┌┐└┘]/;
// 含 │ 分隔且有实际内容的表格行
const TABLE_CELL_ROW = /^[│|].*[│|]$/;
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
// 终端提示行（模型名 + git 状态）
const PROMPT_MODEL = /^\[.*\]\s*$/;
const GIT_PROMPT = /^\S+\s+git:\(\S+\)\s*\*?\s*$/;

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
  // 表格状态跟踪
  private tableLines: string[] = [];
  private inTable = false;

  parse(rawData: string): ParsedOutput[] {
    if (this.pendingReset) {
      this.responseLines = [];
      this.accumulatedText = '';
      this.tableLines = [];
      this.inTable = false;
      this.pendingReset = false;
    }

    const clean = ptyToText(rawData, { cols: 120, rows: 40 });
    const results: ParsedOutput[] = [];
    const lines = clean.split(/\r?\n/);

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (SEPARATOR.test(t)) continue;
      // ❯ 交给 parseLine 处理（可能触发完成）
      const parsed = this.parseLine(t);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  private parseLine(line: string): ParsedOutput | null {
    // ● 标记：Claude 回复的开始（非完成）
    if (line.startsWith(DONE_MARKER)) {
      const afterMarker = this.cleanText(line.slice(1).trim());
      // 太短或匹配 TUI 元素 → 忽略
      if (!afterMarker || afterMarker.length < 10) return null;
      if (/^(high|medium|low)\b/i.test(afterMarker)) return null;
      if (/\b\/effort\b/i.test(afterMarker)) return null;
      // Flush 未输出的表格内容
      if (this.inTable && this.tableLines.length > 0) {
        this.responseLines.push(this.tableLines.join('\n'));
        this.tableLines = [];
        this.inTable = false;
      }
      // ● 行作为普通文本累积，不标记完成
      this.responseLines.push(afterMarker);
      this.accumulatedText = this.responseLines.join('\n');
      return { type: 'response', text: this.accumulatedText, isComplete: false };
    }

    // ❯ 用户输入提示符 → 回复真正结束
    if (INPUT_ECHO.test(line)) {
      if (this.accumulatedText || this.tableLines.length > 0) {
        // Flush 表格
        if (this.inTable && this.tableLines.length > 0) {
          this.responseLines.push(this.tableLines.join('\n'));
          this.tableLines = [];
          this.inTable = false;
        }
        // 更新 accumulatedText 包含表格内容
        this.accumulatedText = this.responseLines.join('\n');
        const fullText = this.accumulatedText;
        this.lastCompleteText = fullText;
        this.responseLines = [];
        this.accumulatedText = '';
        return { type: 'response', text: fullText, isComplete: true };
      }
      return null;
    }

    // TUI 过滤
    if (SEPARATOR.test(line)) return null;
    if (CLAUDE_STATUS.test(line)) return null;
    if (STATUS_FRAGMENT.test(line) && line.length < 60) return null;
    if (PROGRESS.test(line)) return null;
    if (TOOL_LINE.test(line)) return null;
    // 纯边框行 → 丢弃
    if (PURE_BORDER.test(line)) {
      // 如果在表格中，纯边框行可能是分隔线，保持表格继续
      return null;
    }
    // TUI 边框行（如 ╭───ClaudeCodev2.1.97───╮）→ 丢弃
    if (TUI_BORDER_START.test(line) && line.length > 20) {
      return null;
    }
    // 表格内容行（含 │ 分隔且有实际内容）→ 转为 markdown
    if (TABLE_CELL_ROW.test(line) && !MODEL_BAR.test(line)) {
      const cells = line.split(/[│|]/).map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        const mdRow = '| ' + cells.join(' | ') + ' |';
        if (!this.inTable) {
          // 表格第一行，插入 markdown 分隔线
          this.tableLines = [mdRow, '| ' + cells.map(() => '---').join(' | ') + ' |'];
          this.inTable = true;
        } else {
          this.tableLines.push(mdRow);
        }
      }
      return null; // 不直接返回，等表格结束或非表格行到来时一起输出
    }
    // 非表格行：如果之前在收集表格，先输出表格
    if (this.inTable && this.tableLines.length > 0) {
      const tableText = this.tableLines.join('\n');
      this.tableLines = [];
      this.inTable = false;
      // 把表格文本加入累积
      this.responseLines.push(tableText);
      this.accumulatedText = this.responseLines.join('\n');
      // 继续处理当前行（不 return）
    }
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
    if (PROMPT_MODEL.test(line)) return null;
    if (GIT_PROMPT.test(line)) return null;
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
  getBufferText(): string {
    // 如果有未 flush 的表格内容，包含在内
    if (this.inTable && this.tableLines.length > 0) {
      const tableText = this.tableLines.join('\n');
      if (this.accumulatedText) {
        return this.accumulatedText + '\n' + tableText;
      }
      return tableText;
    }
    return this.accumulatedText || this.lastCompleteText;
  }
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
    this.tableLines = [];
    this.inTable = false;
  }
  markNewRound(): void { this.pendingReset = true; }
  getIsWaitingInput(): boolean { return false; }
  getLastComplete(): string { return this.lastCompleteText; }
  getAccumulated(): string { return this.accumulatedText; }
  getRecentLines(): string[] { return this.responseLines.slice(-10); }
}
