import * as fs from 'fs';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { PTYManager } from './pty-manager.js';
import { logger } from '../logger.js';
import type { FeishuEvent } from '../types/index.js';

export interface BridgeConfig {
  feishuAppId: string;
  feishuAppSecret: string;
  botName?: string;
  chatIds: string[];
  allowedUsers: string[];
  claudePath?: string;
  claudeCwd?: string;
  claudeExtraArgs?: string[];
  /** 自动通过 yes/no 问题 */
  autoApprove?: boolean;
}

export class FeishuBridge {
  private feishuService: lark.Client;
  private pty: PTYManager;
  private config: BridgeConfig;
  private lastSentText = '';
  private activeChatId = '';
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private tag: string;
  private wsClient: lark.WSClient | null = null;
  private stdinRl: readline.Interface | null = null;

  // 选项缓冲
  private pendingOptions: string[] = [];
  private optionTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForAnswer = false;

  /** 透传模式：stdin 是 TTY 时，直接透传 PTY 输入输出 */
  private passthrough = false;

  // 危险操作模式（阻止自动通过）
  private static readonly DANGEROUS_PATTERNS = [
    /rm\s+-rf/i,
    /rm\s+-r\s+/i,
    /drop\s+table/i,
    /delete\s+from/i,
    /truncate\s+table/i,
    /chmod\s+777/i,
    /ALTER\s+TABLE.*DROP/i,
    /force\s+push/i,
  ];

  constructor(config: BridgeConfig) {
    this.config = config;
    this.tag = `Bridge:${config.botName || 'default'}`;
    this.feishuService = new lark.Client({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      disableTokenCache: false,
    });
    this.pty = new PTYManager({
      claudePath: config.claudePath,
      cwd: config.claudeCwd,
      extraArgs: config.claudeExtraArgs,
      botName: config.botName,
    });

    // 默认发送目标：用配置的第一个 chatId，确保终端发起的对话也能同步到飞书
    if (config.chatIds.length > 0) {
      this.activeChatId = config.chatIds[0]!;
    }

    this.pty.onEvent((event) => {
      if (event.type === 'response') {
        this.handleClaudeResponse(event.text, event.isComplete, event.isYesNo);
      } else if (event.type === 'question') {
        this.handleQuestion(event.options);
      } else if (event.type === 'exit') {
        logger.error(this.tag, `Claude PTY 退出: code=${event.code}`);
      }
    });
  }

  async start(): Promise<void> {
    this.pty.start();

    const dispatcher = new lark.EventDispatcher({});

    dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const msg = data.message;
          const sender = data.sender;
          if (!msg) return;

          const event: FeishuEvent = {
            chatId: msg.chat_id,
            chatType: msg.chat_type || 'p2p',
            userId: sender?.sender_id?.open_id || '',
            messageId: msg.message_id,
            text: this.parseMessageContent(msg.message_type, msg.content),
            messageType: msg.message_type || 'text',
            timestamp: Date.now(),
          };
          this.handleFeishuMessage(event);
        } catch (err) {
          logger.error(this.tag, `WSClient 消息解析错误: ${err}`);
        }
      },
      // 注册空处理器消除 "no im.message.message_read_v1 handle" 警告
      'im.message.message_read_v1': async () => {},
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      loggerLevel: lark.LoggerLevel.error, // 透传模式下只显示错误，避免干扰 TUI
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info(this.tag, 'Bridge 启动完成: PTY + WSClient');

    // 监听终端 stdin
    this.setupStdin();
  }

  /**
   * 透传模式：stdin 是 TTY 时，PTY 输出直接显示到终端，终端输入直接转发到 PTY
   * 用户看到的是完整的 Claude Code TUI，同时飞书也能同步交互
   */
  private setupStdin(): void {
    if (!process.stdin.isTTY) {
      logger.info(this.tag, '非TTY模式（后台运行），跳过终端透传');
      return;
    }

    this.passthrough = true;
    logger.setStderrEnabled(false); // 透传模式下日志只写文件，不输出到 stderr

    // 覆写 console.warn/console.error 为空操作，防止第三方库输出干扰 Claude Code TUI
    console.warn = () => {};
    console.error = () => {};

    // 1. PTY 输出 → 终端 stdout（直接透传原始数据，保留 TUI 渲染）
    this.pty.onRawData((data: string) => {
      process.stdout.write(data);
    });

    // 2. 终端 stdin → PTY（raw 模式，逐字节转发）
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data: Buffer) => {
      this.pty.writeRaw(data.toString());
    });

    // 3. 终端大小变化 → PTY resize
    const resize = () => {
      this.pty.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    };
    resize();
    process.stdout.on('resize', resize);

    logger.info(this.tag, '透传模式已启用：终端直接显示 Claude Code TUI');
  }

  // ========== 飞书 → Claude ==========

  private handleFeishuMessage(event: FeishuEvent): void {
    if (this.config.chatIds.length > 0 && !this.config.chatIds.includes(event.chatId)) {
      return;
    }
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(event.userId)) {
      logger.warn(this.tag, `忽略未授权用户: ${event.userId}`);
      return;
    }

    this.activeChatId = event.chatId;

    // 透传模式：飞书消息直接写入 PTY（不 reset parser）
    // 非透传模式：用 send() 触发 parser markNewRound
    const sendToPty = (text: string) => {
      if (this.passthrough) {
        this.pty.writeRaw(text + '\r');
      } else {
        this.pty.send(text);
      }
    };

    // 如果在等待选项回答
    if (this.waitingForAnswer) {
      this.waitingForAnswer = false;
      const answer = event.text.trim();
      logger.info(this.tag, `飞书回答 → Claude: "${answer}"`);
      sendToPty(answer);
      return;
    }

    logger.info(this.tag, `飞书 → Claude: "${event.text.slice(0, 100)}" (chat: ${event.chatId})`);
    this.pendingOptions = [];
    this.lastSentText = '';
    if (this.optionTimer) clearTimeout(this.optionTimer);
    sendToPty(event.text);
  }

  // ========== Claude → 飞书 + 终端 ==========

  private handleClaudeResponse(text: string, isComplete: boolean, isYesNo?: boolean): void {
    if (!this.activeChatId) return;
    if (!text.trim()) return;

    if (!isComplete) {
      // 流式累积
      if (this.sendTimer) clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => {
        if (text && text !== this.lastSentText) {
          this.sendText(this.activeChatId, text);
        }
      }, 2000);
      return;
    }

    // 完整回复 → 清除流式定时器
    if (this.sendTimer) clearTimeout(this.sendTimer);

    // yes/no → 自动通过（危险操作除外）
    if (this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
      // 检查是否包含危险操作
      const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(text));
      if (isDangerous) {
        logger.warn(this.tag, `检测到危险操作，阻止自动通过: "${text.slice(0, 80)}"`);
        this.sendText(this.activeChatId, `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`);
        this.waitingForAnswer = true;
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[31m⚠️ 危险操作！请手动确认（飞书或终端输入 yes/no）：\n${text}\x1b[0m\n`);
        }
        return;
      }

      logger.info(this.tag, `自动通过 yes/no: "${text.slice(0, 80)}"`);
      setTimeout(() => {
        if (this.pty.isRunning()) {
          this.pty.send('yes');
        }
      }, 500);
      this.sendText(this.activeChatId, `[自动通过] ${text}\n→ 已自动回复 yes`);
      return;
    }

    // 发送文本回复
    this.sendText(this.activeChatId, text);

    // 检查后面是否可能有选项，启动选项缓冲
    if (this.looksLikeQuestion(text)) {
      this.pendingOptions = [];
      if (this.optionTimer) clearTimeout(this.optionTimer);
      this.optionTimer = setTimeout(() => this.flushOptions(), 1500);
    }
  }

  /**
   * 处理选项事件（从 PTY 解析出的编号选项行）
   */
  private handleQuestion(options: string[]): void {
    if (!this.activeChatId) return;

    this.pendingOptions.push(...options);
    logger.debug(this.tag, `收集选项: ${options.join(', ')} (总计: ${this.pendingOptions.length})`);

    // 重置定时器，等待更多选项
    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.optionTimer = setTimeout(() => this.flushOptions(), 800);
  }

  /**
   * 刷新缓冲的选项，发送纯文本到飞书 + 显示到终端
   */
  private flushOptions(): void {
    if (this.pendingOptions.length === 0) return;

    const options = [...this.pendingOptions];
    this.pendingOptions = [];
    this.optionTimer = null;
    this.waitingForAnswer = true;

    const optionText = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    const message = `📋 请回复编号选择：\n${optionText}`;

    // 发到飞书
    this.sendText(this.activeChatId, message);

    // 终端显示（仅非透传模式，透传模式下 Claude TUI 自己会显示）
    if (!this.passthrough) {
      const terminal = [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📋 Claude 提问，请回复编号（飞书或终端均可）：',
        optionText,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
      ].join('\n');
      fs.writeSync(2, `\x1b[33m${terminal}\x1b[0m\n`);
    }
  }

  // ========== 工具方法 ==========

  private async sendText(chatId: string, text: string): Promise<void> {
    if (text === this.lastSentText) return;
    const maxLen = 4000;
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

    try {
      await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: truncated }),
        },
        params: { receive_id_type: 'chat_id' },
      });
      this.lastSentText = text;
      logger.info(this.tag, `飞书 ← Claude: "${truncated.slice(0, 80)}"`);
    } catch (err) {
      logger.error(this.tag, `发送飞书失败: ${err}`);
    }
  }

  private isYesNoQuestion(text: string): boolean {
    const patterns = [
      /\[y\/n\]/i,
      /\[Y\/n\]/,
      /\(yes\/no\)/i,
      /\(y\/n\)/i,
      /proceed\??/i,
      /continue\??/i,
      /confirm\??/i,
      /Allow this/i,
      /Do you want to/i,
      /是否/i,
      /确认/i,
      /是否继续/i,
    ];
    return patterns.some(p => p.test(text));
  }

  private looksLikeQuestion(text: string): boolean {
    return /[？?]/.test(text) || /选择|选一个|选项|pick|choose|select/i.test(text);
  }

  private parseMessageContent(messageType: string, content: string): string {
    if (!content) return '';
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') return parsed.text || '';
      return parsed.text || content;
    } catch {
      return content;
    }
  }

  stop(): void {
    // 清理所有定时器
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.optionTimer) {
      clearTimeout(this.optionTimer);
      this.optionTimer = null;
    }
    this.pendingOptions = [];
    this.waitingForAnswer = false;

    // 关闭 PTY
    this.pty.stop();

    // 关闭 stdin
    if (this.passthrough) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch (_) { /* ignore */ }
    }
    if (this.stdinRl) {
      this.stdinRl.close();
      this.stdinRl = null;
    }

    // 关闭 WSClient（飞书 SDK 可能没有 stop 方法，置空即可）
    this.wsClient = null;

    logger.info(this.tag, 'Bridge 已停止');
  }
}
