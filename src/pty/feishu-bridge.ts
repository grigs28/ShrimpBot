import * as fs from 'fs';
import * as path from 'path';
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
  /** clone 模式：飞书与终端完全同步，多行完整显示 */
  clone?: boolean;
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
  /** 流式累积缓冲区：存储最新的累积文本 */
  private streamBuffer = '';
  /** clone 模式上次发送的文本（用于去重） */
  private cloneLastSent = '';

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
        logger.info(this.tag, `Claude PTY 退出: code=${event.code}，关闭 Bridge`);
        this.stop();
        process.exit(event.code || 0);
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

    // 2. 终端 stdin → PTY（raw 模式，拦截 Ctrl+C / Ctrl+D 退出）
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString();
      // Ctrl+C (0x03) 或 Ctrl+D (0x04) → 退出 bridge
      if (input === '\x03' || input === '\x04') {
        this.stop();
        process.exit(0);
      }
      this.pty.writeRaw(input);
    });

    // 3. 终端大小变化 → PTY resize
    const resize = () => {
      this.pty.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    };
    resize();
    process.stdout.on('resize', resize);

    logger.info(this.tag, '透传模式已启用：终端直接显示 Claude Code TUI');
  }

  /**
   * 发送初始命令（-c 参数），透传模式用 writeRaw，否则用 send
   */
  sendInitialCommand(command: string): void {
    if (this.passthrough) {
      this.pty.writeRaw(command + '\r');
    } else {
      this.pty.send(command);
    }
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
    logger.info(this.tag, `活跃会话: ${event.chatId}（将同步 Claude 回复到此会话）`);

    // 首次收到消息时自动保存 chatId 到 .env
    this.saveChatId(event.chatId);

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
      // 流式累积：更新缓冲区
      this.streamBuffer = text;
      if (this.sendTimer) clearTimeout(this.sendTimer);

      if (this.config.clone) {
        // clone 模式：只缓存，不流式发送（避免多条重复消息）
        // 最终 isComplete=true 时一次性发送完整文本
      } else {
        // 非 clone 模式：2 秒防抖后发送当前文本
        this.sendTimer = setTimeout(() => {
          if (text && text !== this.lastSentText) {
            this.sendText(this.activeChatId, text);
          }
        }, 2000);
      }
      return;
    }

    // 完整回复 → 清除流式定时器
    if (this.sendTimer) clearTimeout(this.sendTimer);

    // yes/no → 自动通过（危险操作除外）
    if (this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
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

    // 发送完整回复
    if (this.config.clone) {
      this.sendCloneText(this.activeChatId, text);
    } else {
      this.sendText(this.activeChatId, text);
    }
    this.streamBuffer = '';

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

  /**
   * clone 模式发送：用飞书 post + md 富文本发送完整内容
   * 支持代码块、列表等 Markdown 格式
   */
  private async sendCloneText(chatId: string, text: string): Promise<void> {
    if (text === this.cloneLastSent) return;
    this.cloneLastSent = text;

    // 飞书 post 类型限制 30KB
    const maxBytes = 30 * 1024;
    const encoder = new TextEncoder();

    // 如果超过限制，分片发送
    if (encoder.encode(text).length > maxBytes) {
      const chunks = this.splitText(text, maxBytes);
      for (const chunk of chunks) {
        await this.sendPostMd(chatId, chunk);
      }
    } else {
      await this.sendPostMd(chatId, text);
    }

    logger.info(this.tag, `飞书 ← Claude (clone): "${text.slice(0, 80)}"`);
  }

  /** 用飞书 post + md 发送 */
  private async sendPostMd(chatId: string, text: string): Promise<void> {
    try {
      await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              content: [[{ tag: 'md', text }]],
            },
          }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    } catch (err) {
      logger.error(this.tag, `飞书 post 发送失败，降级为 text: ${err}`);
      // 降级为纯文本
      await this.sendText(chatId, text);
    }
  }

  /** 按字节大小分片文本 */
  private splitText(text: string, maxBytes: number): string[] {
    const encoder = new TextEncoder();
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      const test = current ? `${current}\n${line}` : line;
      if (encoder.encode(test).length > maxBytes * 0.9) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = test;
      }
    }
    if (current) chunks.push(current);
    return chunks;
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

  /**
   * 保存 chatId 到项目 .env 文件（首次收到消息时自动调用）
   */
  private saveChatId(chatId: string): void {
    const envPath = path.join(process.cwd(), '.env');
    const existing = this.config.chatIds || [];

    // 已存在则跳过
    if (existing.includes(chatId)) return;

    // 添加到 chatIds 列表
    const newChatIds = [...existing, chatId];
    this.config.chatIds = newChatIds;

    // 读取现有 .env 内容
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }

    // 更新或添加 FEISHU_CHAT_IDS
    const chatIdsValue = newChatIds.join(',');
    const chatIdsLine = `FEISHU_CHAT_IDS=${chatIdsValue}`;

    if (/^FEISHU_CHAT_IDS=/m.test(envContent)) {
      envContent = envContent.replace(/^FEISHU_CHAT_IDS=.*$/m, chatIdsLine);
    } else {
      envContent = envContent.trimEnd() + '\n' + chatIdsLine + '\n';
    }

    fs.writeFileSync(envPath, envContent);
    logger.info(this.tag, `已保存 chatId 到 .env: ${chatIdsValue}`);
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
