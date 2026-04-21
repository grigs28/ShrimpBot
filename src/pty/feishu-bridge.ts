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

/** 已知会话信息 */
interface ChatInfo {
  chatId: string;
  chatType: 'p2p' | 'group';
  /** 自动发现的时间 */
  discoveredAt: number;
}

export class FeishuBridge {
  private feishuService: lark.Client;
  private pty: PTYManager;
  private config: BridgeConfig;
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
  /** clone 模式上次发送的文本（用于去重），按 chatId 分开 */
  private cloneLastSentMap = new Map<string, string>();
  /** 普通模式上次发送的文本（用于去重），按 chatId 分开 */
  private lastSentTextMap = new Map<string, string>();

  // 消息队列：Claude 正在回复时，新消息排队等待
  private messageQueue: Array<{ event: FeishuEvent; text: string }> = [];
  /** Claude 是否正在回复中 */
  private claudeBusy = false;

  /**
   * 当前回复目标 chatId（Claude 正在回复的会话）
   * 只有 dispatchToClaude 和 processQueue 才会更新此字段
   */
  private responseChatId = '';
  /**
   * 默认同步目标（终端发起的对话同步到这里）
   * 配置的第一个 chatId 或最近一次飞书消息来源
   */
  private defaultChatId = '';

  /** 已知会话注册表：chatId → ChatInfo */
  private knownChats = new Map<string, ChatInfo>();

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

    // 默认同步目标：配置的第一个 chatId
    if (config.chatIds.length > 0) {
      this.defaultChatId = config.chatIds[0]!;
      this.responseChatId = this.defaultChatId;
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
   */
  private setupStdin(): void {
    if (!process.stdin.isTTY) {
      logger.info(this.tag, '非TTY模式（后台运行），跳过终端透传');
      return;
    }

    this.passthrough = true;
    logger.setStderrEnabled(false);

    console.warn = () => {};
    console.error = () => {};

    // 1. PTY 输出 → 终端 stdout
    this.pty.onRawData((data: string) => {
      process.stdout.write(data);
    });

    // 2. 终端 stdin → PTY
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString();
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

  sendInitialCommand(command: string): void {
    if (this.passthrough) {
      this.pty.writeRaw(command + '\r');
    } else {
      this.pty.send(command);
    }
  }

  // ========== 飞书 → Claude ==========

  private handleFeishuMessage(event: FeishuEvent): void {
    // 注册已知会话（始终记录，在过滤之前）
    this.registerChat(event);

    // 自动保存新 chatId 到 .env 并加入白名单
    this.saveChatId(event.chatId);

    // 过滤不在白名单中的会话
    if (this.config.chatIds.length > 0 && !this.config.chatIds.includes(event.chatId)) {
      return;
    }
    // 过滤不在白名单中的用户
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(event.userId)) {
      logger.warn(this.tag, `忽略未授权用户: ${event.userId}`);
      return;
    }

    const text = event.text.trim();
    if (!text) return;

    const chatLabel = event.chatType === 'p2p' ? '私聊' : '群聊';

    // 如果在等待选项回答 → 直接发送，不受队列限制
    if (this.waitingForAnswer) {
      this.waitingForAnswer = false;
      logger.info(this.tag, `[${chatLabel}] 飞书回答 → Claude: "${text}" (${event.chatId})`);
      this.sendToPty(text);
      this.claudeBusy = true;
      return;
    }

    // Claude 正在回复 → 消息排队
    if (this.claudeBusy) {
      logger.info(this.tag, `[${chatLabel}] Claude 忙碌，排队: "${text.slice(0, 50)}" (队列: ${this.messageQueue.length + 1})`);
      this.messageQueue.push({ event, text });
      // 通知排队
      this.sendText(event.chatId, `⏳ 排队中（前面还有 ${this.messageQueue.length} 条消息）`);
      return;
    }

    // 直接发送
    this.dispatchToClaude(event, text);
  }

  /**
   * 注册已知会话信息
   */
  private registerChat(event: FeishuEvent): void {
    if (!this.knownChats.has(event.chatId)) {
      this.knownChats.set(event.chatId, {
        chatId: event.chatId,
        chatType: event.chatType,
        discoveredAt: Date.now(),
      });
      const label = event.chatType === 'p2p' ? '私聊' : '群聊';
      logger.info(this.tag, `发现新会话 [${label}]: ${event.chatId} (用户: ${event.userId})`);
    }
  }

  /**
   * 将消息发送给 Claude PTY，并设置回复目标
   */
  private dispatchToClaude(event: FeishuEvent, text: string): void {
    // 设置回复目标为此消息来源
    this.responseChatId = event.chatId;
    // 更新默认同步目标
    this.defaultChatId = event.chatId;

    const chatLabel = event.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `[${chatLabel}] 飞书 → Claude: "${text.slice(0, 100)}" (${event.chatId})`);

    this.pendingOptions = [];
    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.claudeBusy = true;
    this.sendToPty(text);
  }

  private sendToPty(text: string): void {
    if (this.passthrough) {
      this.pty.writeRaw(text + '\r');
    } else {
      this.pty.send(text);
    }
  }

  /**
   * Claude 回复完成后，检查队列是否有待处理消息
   */
  private processQueue(): void {
    this.claudeBusy = false;

    if (this.messageQueue.length === 0) return;

    const item = this.messageQueue.shift()!;
    const chatLabel = item.event.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `[${chatLabel}] 处理队列: "${item.text.slice(0, 50)}" (剩余: ${this.messageQueue.length})`);

    this.dispatchToClaude(item.event, item.text);
  }

  // ========== Claude → 飞书 + 终端 ==========

  private handleClaudeResponse(text: string, isComplete: boolean, isYesNo?: boolean): void {
    // 使用 responseChatId（当前回复目标），回退到 defaultChatId
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;
    if (!text.trim()) return;

    if (!isComplete) {
      this.streamBuffer = text;
      if (this.sendTimer) clearTimeout(this.sendTimer);

      if (this.config.clone) {
        // clone 模式：只缓存
      } else {
        this.sendTimer = setTimeout(() => {
          const lastSent = this.lastSentTextMap.get(targetChatId) || '';
          if (text && text !== lastSent) {
            this.sendText(targetChatId, text);
          }
        }, 2000);
      }
      return;
    }

    if (this.sendTimer) clearTimeout(this.sendTimer);

    // 先检测是否包含编号选项（如果有选项，不自动通过）
    const hasOptions = this.containsNumberedOptions(text);

    // yes/no → 自动通过（仅当没有编号选项时）
    if (!hasOptions && this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
      const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(text));
      if (isDangerous) {
        logger.warn(this.tag, `检测到危险操作，阻止自动通过: "${text.slice(0, 80)}"`);
        // 危险操作：两端显示，等待手动确认
        this.sendText(targetChatId, `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`);
        this.waitingForAnswer = true;
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[31m⚠️ 危险操作！请手动确认（飞书或终端输入 yes/no）：\n${text}\x1b[0m\n`);
        }
        return;
      }

      // 自动通过：两端都显示
      logger.info(this.tag, `自动通过 yes/no: "${text.slice(0, 80)}"`);
      const approveMsg = `[自动通过] ${text}\n→ 已自动回复 yes`;
      // 发到飞书
      this.sendText(targetChatId, approveMsg);
      // 发到终端（透传模式下 TUI 自己会显示，非透传模式需要手动显示）
      if (!this.passthrough) {
        fs.writeSync(2, `\x1b[36m${approveMsg}\x1b[0m\n`);
      }
      setTimeout(() => {
        if (this.pty.isRunning()) {
          this.pty.send('yes');
        }
      }, 500);
      return;
    }

    // 发送完整回复（双端显示）
    if (this.config.clone) {
      this.sendCloneText(targetChatId, text);
    } else {
      this.sendText(targetChatId, text);
    }
    this.streamBuffer = '';

    // 检查是否有选项 → 两端显示，等待用户回答
    if (this.looksLikeQuestion(text)) {
      this.pendingOptions = [];
      if (this.optionTimer) clearTimeout(this.optionTimer);
      this.optionTimer = setTimeout(() => this.flushOptions(), 1500);
    } else {
      this.processQueue();
    }
  }

  private handleQuestion(options: string[]): void {
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;

    this.pendingOptions.push(...options);
    logger.debug(this.tag, `收集选项: ${options.join(', ')} (总计: ${this.pendingOptions.length})`);

    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.optionTimer = setTimeout(() => this.flushOptions(), 800);
  }

  private flushOptions(): void {
    this.optionTimer = null;

    if (this.pendingOptions.length === 0) {
      this.processQueue();
      return;
    }

    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;

    const options = [...this.pendingOptions];
    this.pendingOptions = [];
    this.waitingForAnswer = true;

    const optionText = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    const message = `📋 请回复编号选择：\n${optionText}`;

    this.sendText(targetChatId, message);

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
    const lastSent = this.lastSentTextMap.get(chatId) || '';
    if (text === lastSent) return;
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
      this.lastSentTextMap.set(chatId, text);
      logger.info(this.tag, `飞书 ← Claude (${chatId}): "${truncated.slice(0, 80)}"`);
    } catch (err) {
      logger.error(this.tag, `发送飞书失败: ${err}`);
    }
  }

  private async sendCloneText(chatId: string, text: string): Promise<void> {
    const lastSent = this.cloneLastSentMap.get(chatId) || '';
    if (text === lastSent) return;
    this.cloneLastSentMap.set(chatId, text);

    const maxBytes = 30 * 1024;
    const encoder = new TextEncoder();

    if (encoder.encode(text).length > maxBytes) {
      const chunks = this.splitText(text, maxBytes);
      for (const chunk of chunks) {
        await this.sendPostMd(chatId, chunk);
      }
    } else {
      await this.sendPostMd(chatId, text);
    }

    logger.info(this.tag, `飞书 ← Claude (clone, ${chatId}): "${text.slice(0, 80)}"`);
  }

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
      await this.sendText(chatId, text);
    }
  }

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
    // 参考 claude-monitor：prompt + options 同时存在才判定
    const PERM_PATTERNS = [
      /requires approval/i,
      /do you want/i,
      /proceed/i,
      /\?\s*\[y\/n\]/i,
      /\?\s*\[Y\/n\]/,
      /\(yes\/no\)/i,
      /\(y\/n\)/i,
    ];
    const hasPrompt = PERM_PATTERNS.some(p => p.test(text));
    if (!hasPrompt) return false;

    const hasYes = /\byes\b/i.test(text);
    const hasNo = /\bno\b/i.test(text);
    const hasAlways = /\balways\b/i.test(text) || /don'?t ask/i.test(text);
    return (hasYes && hasNo) || hasAlways;
  }

  private looksLikeQuestion(text: string): boolean {
    return /[？?]/.test(text) || /选择|选一个|选项|pick|choose|select/i.test(text);
  }

  /**
   * 检测文本中是否包含编号选项（1. xxx  2. xxx 等）
   */
  private containsNumberedOptions(text: string): boolean {
    const lines = text.split('\n');
    let optionCount = 0;
    for (const line of lines) {
      if (/^\s*\d{1,2}[.)]\s+/.test(line) || /^\s*[(（]\d{1,2}[)）]\s+/.test(line)) {
        optionCount++;
      }
    }
    return optionCount >= 2; // 至少 2 个编号选项才认为是选项列表
  }

  /**
   * 保存 chatId 到项目 .env 文件（自动记录新发现的会话）
   */
  private saveChatId(chatId: string): void {
    const envPath = path.join(process.cwd(), '.env');
    const existing = this.config.chatIds || [];

    if (existing.includes(chatId)) return;

    const newChatIds = [...existing, chatId];
    this.config.chatIds = newChatIds;

    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }

    const chatIdsValue = newChatIds.join(',');
    const chatIdsLine = `FEISHU_CHAT_IDS=${chatIdsValue}`;

    if (/^FEISHU_CHAT_IDS=/m.test(envContent)) {
      envContent = envContent.replace(/^FEISHU_CHAT_IDS=.*$/m, chatIdsLine);
    } else {
      envContent = envContent.trimEnd() + '\n' + chatIdsLine + '\n';
    }

    fs.writeFileSync(envPath, envContent);

    const info = this.knownChats.get(chatId);
    const label = info?.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `已保存 [${label}] chatId 到 .env: ${chatId} (总计: ${newChatIds.length} 个会话)`);
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
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (this.optionTimer) { clearTimeout(this.optionTimer); this.optionTimer = null; }
    this.pendingOptions = [];
    this.waitingForAnswer = false;
    this.messageQueue = [];
    this.claudeBusy = false;

    this.pty.stop();

    if (this.passthrough) {
      try { process.stdin.setRawMode(false); process.stdin.pause(); } catch (_) { /* ignore */ }
    }
    if (this.stdinRl) { this.stdinRl.close(); this.stdinRl = null; }

    this.wsClient = null;
    logger.info(this.tag, 'Bridge 已停止');
  }
}
