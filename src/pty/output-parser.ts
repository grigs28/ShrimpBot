import stripAnsi from 'strip-ansi';

// Claude Code TUI 输出解析器
// 从 PTY 的原始输出中提取 Claude 的回复文本和问题

// Loading 动画字符（单个 Unicode 字符，用于旋转指示器）
const LOADING_CHARS = new Set(['✶', '✻', '✽', '✢', '·', '*', '●']);

// 用户输入回显：❯ 后面是用户输入
const INPUT_ECHO = /^❯\s/;

// 分隔线
const SEPARATOR = /^─+$/;

// 状态栏信息
const STATUS_BAR = /^\[.*\].*│/;

// MCP 状态信息
const MCP_STATUS = /^\d+ MCP server/;

// 完成标记
const DONE_MARKER = '●';

// 已知的 TUI 状态文字模式（需要过滤掉的噪音）
const NOISE_PATTERNS = [
  /^Noodling/i,
  /^Swooping/i,
  /^high·\/effort/i,
  /^bypass permissions/i,
  /^\d+ MCP/i,
  /^Context\s+░/i,
  /^\w+…$/,           // 纯状态词 + 省略号
  /^shift\+tab/i,
  /^\d+%$/,            // 纯百分比
  /^[a-z]{1,3}…$/,     // 短字母 + 省略号（如 ng… g…）
];

// Yes/No 自动通过模式
const YES_NO_PATTERNS = [
  /\?\s*\[y\/n\]/i,
  /\?\s*\[Y\/n\]/,
  /\(yes\/no\)/i,
  /\(y\/n\)/i,
  /proceed\?/i,
  /continue\?/i,
  /confirm\?/i,
  /allow\?/i,
  /approve\?/i,
  /是否/i,
  /确认/i,
  /继续/i,
];

// 选项模式（数字编号的选项，数字和点后面可选空格，内容不超过 50 字）
const OPTION_PATTERN = /^\s*(\d{1,2})\.\s*(.{1,50})$/;
// 额外选项格式
const OPTION_ALT_PATTERNS = [
  /^\s*(\d{1,2})[)]\s*(.{1,50})$/,                // 1) xxx
  /^\s*[(（](\d{1,2})[)）]\s*(.{1,50})$/,          // (1) xxx 或 （1）xxx
];

export interface ParsedOutput {
  type: 'response' | 'question' | 'status' | 'loading' | 'ignore';
  text: string;
  /** 是否是完整回复（带 ● 标记） */
  isComplete: boolean;
  /** 如果是 yes/no 问题 */
  isYesNo?: boolean;
  /** 如果有选项 */
  options?: string[];
}

export class OutputParser {
  private accumulatedText = '';
  private lastCompleteText = '';
  private recentLines: string[] = [];
  private isWaitingInput = false;
  /** 是否需要在新内容到来时 reset 累积 */
  private pendingReset = false;
  /** 当前响应的行列表（用于正确累积多行） */
  private responseLines: string[] = [];

  /**
   * 处理一个 PTY 输出 chunk
   */
  parse(rawData: string): ParsedOutput[] {
    // 处理延迟 reset：新消息发送后，第一个 chunk 到来时清理旧状态
    if (this.pendingReset) {
      this.accumulatedText = '';
      this.responseLines = [];
      this.recentLines = [];
      this.isWaitingInput = false;
      this.pendingReset = false;
    }

    const clean = stripAnsi(rawData);
    const results: ParsedOutput[] = [];

    // 按行分割（\r 或 \r\n）
    const lines = clean.split(/\r\r?\n?/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 检测输入提示符（Claude 等待用户输入）
      if (INPUT_ECHO.test(trimmed)) {
        this.isWaitingInput = true;
        continue;
      }

      // 检测分隔线后面跟着输入提示符 = 上一轮完成了
      if (SEPARATOR.test(trimmed)) {
        // 分隔线意味着新一轮对话开始
        this.isWaitingInput = false;
        // 新一轮开始时，清除上一轮的累积文本
        this.accumulatedText = '';
        continue;
      }

      const parsed = this.parseLine(trimmed);
      if (parsed) {
        results.push(parsed);
        // 保留最近的行用于问题检测
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
    // 跳过纯 loading 动画（单个旋转字符）
    if (line.length <= 2 && LOADING_CHARS.has(line)) {
      return { type: 'loading', text: '', isComplete: false };
    }

    // 跳过分隔线
    if (SEPARATOR.test(line)) return null;

    // 跳过状态栏
    if (STATUS_BAR.test(line)) return null;

    // 跳过 MCP 状态
    if (MCP_STATUS.test(line)) return null;

    // 跳过 TUI 框架
    if (line.startsWith('╭') || line.startsWith('╰') || line.startsWith('│')) return null;

    // 跳过 Context 进度条
    if (line.includes('Context') && line.includes('░')) return null;

    // 检测选项行（1. xxx  2. xxx  1) xxx  (1) xxx）
    const optMatch = line.match(OPTION_PATTERN)
      || (line.match(OPTION_ALT_PATTERNS[0]) || undefined)
      || (line.match(OPTION_ALT_PATTERNS[1]) || undefined);
    if (optMatch && optMatch[2]) {
      return {
        type: 'question',
        text: optMatch[2].trim(),
        isComplete: true,
        options: [optMatch[2].trim()],
      };
    }

    // 检测 Claude 回复
    // 模式1: ●文本内容（完成标记 + 完整回复）
    if (line.startsWith(DONE_MARKER)) {
      const text = line.slice(1).trim();
      const cleanText = this.cleanResponseText(text);
      if (cleanText) {
        // 检查 ● 后面的文本是否是选项行（如 ●1. 蓝色）
        const optMatch = cleanText.match(OPTION_PATTERN);
        if (optMatch) {
          return {
            type: 'question',
            text: optMatch[2]!.trim(),
            isComplete: true,
            options: [optMatch[2]!.trim()],
          };
        }

        this.lastCompleteText = cleanText;
        this.accumulatedText = '';
        this.isWaitingInput = true;

        // 检查是否是 yes/no 问题
        const isYesNo = YES_NO_PATTERNS.some(p => p.test(cleanText));

        return {
          type: 'response',
          text: cleanText,
          isComplete: true,
          isYesNo,
        };
      }
    }

    // 模式2: 流式文本累积（可能以 loading 字符开头后跟文本）
    if (line.length > 1) {
      let text = line;

      // 去掉开头的 loading 字符
      if (LOADING_CHARS.has(text[0]!) && text.length > 1) {
        text = text.slice(1);
      }

      text = text.trim();

      // 如果是 stop hook 相关，跳过
      if (text.includes('running stop hook')) return null;

      // 如果是已知的噪音模式，跳过
      if (NOISE_PATTERNS.some(p => p.test(text))) return null;

      // 短文本噪音：2-3 个字符的纯 ASCII（如 "0q", "ng", "g"）
      if (text.length <= 3 && /^[a-z0-9]+$/.test(text)) return null;

      // 如果看起来是有意义的文本（含中文 或 较长的英文句子）
      const hasChinese = /[\u4e00-\u9fff]/.test(text);
      const isLongEnglish = text.length > 10 && /^[a-zA-Z]/.test(text) && /\s/.test(text);

      if (hasChinese || isLongEnglish) {
        // 行列表累积：检测是新行还是当前行的更新
        const lastLine = this.responseLines.length > 0 ? this.responseLines[this.responseLines.length - 1] : '';
        if (lastLine && (text.startsWith(lastLine) || lastLine.startsWith(text))) {
          // 同一行更新（TUI 重绘）：替换最后一行
          this.responseLines[this.responseLines.length - 1] = text.length > lastLine.length ? text : lastLine;
        } else {
          // 新行：追加
          this.responseLines.push(text);
        }
        this.accumulatedText = this.responseLines.join('\n');

        // 如果包含 ● 标记，说明回复完成了
        const doneIdx = text.indexOf(DONE_MARKER);
        if (doneIdx >= 0) {
          // 返回累积的全部文本（包含 ● 后的最后一行）
          const fullText = this.accumulatedText ? this.accumulatedText : text;
          const cleanFull = this.cleanResponseText(fullText.replace(/●/g, '').trim());
          if (cleanFull) {
            this.lastCompleteText = cleanFull;
            this.accumulatedText = '';
            this.responseLines = [];
            this.isWaitingInput = true;
            return { type: 'response', text: cleanFull, isComplete: true };
          }
        }

        return { type: 'response', text: this.accumulatedText, isComplete: false };
      }
    }

    return null;
  }

  /**
   * 清理回复文本中的尾部状态信息
   */
  private cleanResponseText(text: string): string {
    return text
      .replace(/\s*·\s*Noodling[^"]*$/, '')
      .replace(/\s*·\s*\w+\.\.\..*$/, '')
      .trim();
  }

  /** 标记新一轮对话，延迟 reset 确保旧输出处理完 */
  markNewRound(): void {
    this.pendingReset = true;
  }

  /** 是否在等待用户输入 */
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
