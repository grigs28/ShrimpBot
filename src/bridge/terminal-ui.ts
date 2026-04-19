const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GRAY = '\x1b[90m';

export class TerminalUI {
  showFeishuMessage(userName: string, text: string): void {
    process.stdout.write(`\n${BLUE}[飞书] ${userName}${RESET}: ${text}\n\n`);
  }

  showTerminalInput(text: string): void {
    process.stdout.write(`${CYAN}[终端]${RESET} ${text}\n`);
  }

  showClaudeText(text: string): void {
    process.stdout.write(text);
  }

  showToolCall(name: string, detail?: string): void {
    const detailStr = detail ? ` ${detail}` : '';
    process.stdout.write(`\n${YELLOW}  ${name}${detailStr}${RESET}\n`);
  }

  showToolDone(): void {
    // No-op for now
  }

  showStreamDelta(text: string): void {
    process.stdout.write(text);
  }

  showResult(text: string, costUsd?: number, durationMs?: number): void {
    process.stdout.write(`\n${GREEN}${BOLD}── 完成 ──${RESET}\n`);

    if (durationMs !== undefined) {
      const durationStr = durationMs >= 60000
        ? `${(durationMs / 60000).toFixed(1)}min`
        : `${(durationMs / 1000).toFixed(1)}s`;
      process.stdout.write(`${GRAY}${DIM}耗时: ${durationStr}${RESET}  `);
    }

    if (costUsd !== undefined) {
      process.stdout.write(`${GRAY}${DIM}费用: $${costUsd.toFixed(4)}${RESET}`);
    }

    if (durationMs !== undefined || costUsd !== undefined) {
      process.stdout.write('\n');
    }

    const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
    if (preview) {
      process.stdout.write(`\n${preview}\n`);
    }
  }

  showError(message: string): void {
    process.stdout.write(`${BOLD}\x1b[31m错误: ${message}${RESET}\n`);
  }

  showSessionInfo(sessionId: string): void {
    const shortId = sessionId.slice(0, 8);
    process.stdout.write(`${DIM}Session: ${shortId}...${RESET}\n`);
  }

  showStatus(message: string): void {
    process.stdout.write(`${GRAY}${DIM}${message}${RESET}\n`);
  }
}
