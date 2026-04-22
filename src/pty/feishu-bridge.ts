import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { PTYManager } from './pty-manager.js';
import { WebServer } from './web-server.js';
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
  autoApprove?: boolean;
  clone?: boolean;
  webPort?: number;
  /** 是否启用 Web 终端（默认 false） */
  webEnabled?: boolean;
}

interface ChatInfo {
  chatId: string;
  chatType: 'p2p' | 'group';
  discoveredAt: number;
}

export class FeishuBridge {
  private feishuService: lark.Client;
  private pty: PTYManager;
  private webServer: WebServer;
  private config: BridgeConfig;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private tag: string;
  private wsClient: lark.WSClient | null = null;
  private stdinRl: readline.Interface | null = null;

  private pendingOptions: string[] = [];
  private optionTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForAnswer = false;

  private passthrough = false;
  private streamBuffer = '';
  /** 按会话记录已发送的累积文本（用于增量对比） */
  private lastSentTextMap = new Map<string, string>();

  /** 是否已收到第一条飞书消息（启动前的 PTY 输出不发送到飞书） */
  private firstMessageReceived = false;

  /** 最近发给 Claude 的用户消息（用于去重回显） */
  private lastUserMessage = '';

  private messageQueue: Array<{ event: FeishuEvent; text: string }> = [];
  private claudeBusy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendTime = 0;
  private readonly SEND_INTERVAL_MS = 5000; // 飞书发送最小间隔，防止限频

  private responseChatId = '';
  private defaultChatId = '';
  private knownChats = new Map<string, ChatInfo>();

  private static readonly DANGEROUS_PATTERNS = [
    /rm\s+-rf/i, /rm\s+-r\s+/i, /drop\s+table/i, /delete\s+from/i,
    /truncate\s+table/i, /chmod\s+777/i, /ALTER\s+TABLE.*DROP/i, /force\s+push/i,
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

    if (config.chatIds.length > 0) {
      this.defaultChatId = config.chatIds[0]!;
      this.responseChatId = this.defaultChatId;
    }

    // Web 终端服务
    this.webServer = new WebServer({
      onPtyData: (cb) => { this.pty.onRawData(cb); },
      ptyWrite: (data) => {
        // Web/API 输入也标记活跃（让 Claude 回复能转发到飞书）
        if (!this.firstMessageReceived) {
          this.firstMessageReceived = true;
          logger.info(this.tag, 'Web/API 输入触发，开始转发 Claude 输出');
        }
        this.pty.writeRaw(data);
      },
      getBufferText: () => this.pty.getBufferText(),
      getTerminalSize: () => this.pty.getTerminalSize(),
      botName: config.botName,
    }, config.webPort || 5554);

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

    // Web 终端（仅显式启用时启动）
    if (this.config.webEnabled) {
      const webPort = this.config.webPort || 5554;
      const portAvailable = await WebServer.isPortAvailable(webPort);
      if (portAvailable) {
        this.webServer.start();
        logger.info(this.tag, `Web 终端端口 ${webPort} 可用，已启动`);
      } else {
        logger.warn(this.tag, `Web 终端端口 ${webPort} 已被占用，跳过 Web 终端`);
      }
    }

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
      'im.message.message_read_v1': async () => {},
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.feishuAppId,
      appSecret: this.config.feishuAppSecret,
      loggerLevel: lark.LoggerLevel.error,
    });
    this.wsClient.start({ eventDispatcher: dispatcher });

    logger.info(this.tag, 'Bridge 启动完成: PTY + WSClient + WebTerminal');
    this.setupStdin();
  }

  private setupStdin(): void {
    if (!process.stdin.isTTY) return;

    this.passthrough = true;
    logger.setStderrEnabled(false);
    console.warn = () => {};
    console.error = () => {};

    this.pty.onRawData((data: string) => { process.stdout.write(data); });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString();
      if (input === '\x03' || input === '\x04') { this.stop(); process.exit(0); }
      if (!this.firstMessageReceived) {
        this.firstMessageReceived = true;
        logger.info(this.tag, '终端输入触发，开始转发 Claude 输出');
      }
      this.pty.writeRaw(input);
    });

    const resize = () => {
      this.pty.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    };
    resize();
    process.stdout.on('resize', resize);
    logger.info(this.tag, '透传模式已启用');
  }

  sendInitialCommand(command: string): void {
    this.sendToPty(command);
  }

  // ========== 飞书 → Claude ==========

  private handleFeishuMessage(event: FeishuEvent): void {
    // 注册已知会话 + 保存 chatId（始终执行，在过滤之前）
    this.registerChat(event);
    this.saveChatId(event.chatId);

    // 过滤不在白名单中的会话
    if (this.config.chatIds.length > 0 && !this.config.chatIds.includes(event.chatId)) return;
    // 过滤不在白名单中的用户
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(event.userId)) {
      logger.warn(this.tag, `忽略未授权用户: ${event.userId}`);
      return;
    }

    const text = event.text.trim();
    if (!text) return;

    // 标记已收到第一条飞书消息
    if (!this.firstMessageReceived) {
      this.firstMessageReceived = true;
      logger.info(this.tag, '收到第一条飞书消息，开始转发 Claude 输出');
    }

    const chatLabel = event.chatType === 'p2p' ? '私聊' : '群聊';

    // 等待选项回答 → 直接发送（但排除常见命令，防止误判）
    if (this.waitingForAnswer) {
      const isLikelyCommand = /^(ls|dir|cat|pwd|cd|help|hi|hello|你好|测试)/i.test(text) || text.length > 50;
      if (!isLikelyCommand) {
        this.waitingForAnswer = false;
        logger.info(this.tag, `[${chatLabel}] 飞书回答 → Claude: "${text}" (${event.chatId})`);
        this.sendToPty(text);
        this.claudeBusy = true;
        return;
      }
      // 看起来像命令而非选项回答 → 取消等待，按正常消息处理
      logger.info(this.tag, `[${chatLabel}] 取消 waitingForAnswer，当作新消息: "${text.slice(0, 50)}"`);
      this.waitingForAnswer = false;
    }

    // Claude 忙碌 → 排队
    if (this.claudeBusy) {
      logger.info(this.tag, `[${chatLabel}] 排队: "${text.slice(0, 50)}" (队列: ${this.messageQueue.length + 1})`);
      this.messageQueue.push({ event, text });
      this.sendRawText(event.chatId, `⏳ 排队中（前面还有 ${this.messageQueue.length} 条消息）`);
      return;
    }

    this.dispatchToClaude(event, text);
  }

  private registerChat(event: FeishuEvent): void {
    if (!this.knownChats.has(event.chatId)) {
      this.knownChats.set(event.chatId, {
        chatId: event.chatId, chatType: event.chatType, discoveredAt: Date.now(),
      });
      const label = event.chatType === 'p2p' ? '私聊' : '群聊';
      logger.info(this.tag, `发现新会话 [${label}]: ${event.chatId}`);
    }
  }

  private dispatchToClaude(event: FeishuEvent, text: string): void {
    this.responseChatId = event.chatId;
    this.defaultChatId = event.chatId;
    this.lastUserMessage = text;

    const chatLabel = event.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `[${chatLabel}] 飞书 → Claude: "${text.slice(0, 100)}" (${event.chatId})`);

    this.pendingOptions = [];
    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.claudeBusy = true;
    // 新一轮：重置增量发送状态
    this.lastSentTextMap.delete(event.chatId);
    this.sendToPty(text);

    // 安全超时：120 秒无完成响应则强制解除阻塞
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      if (this.claudeBusy) {
        logger.warn(this.tag, '⏰ 响应超时（120s），强制解除 claudeBusy');
        this.processQueue();
      }
    }, 120_000);
  }

  /**
   * 飞书消息发送到 Claude Code PTY
   */
  private sendToPty(text: string): void {
    this.pty.send(text);
  }

  private processQueue(): void {
    this.claudeBusy = false;
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
    if (this.messageQueue.length === 0) return;

    const item = this.messageQueue.shift()!;
    const chatLabel = item.event.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `[${chatLabel}] 处理队列: "${item.text.slice(0, 50)}" (剩余: ${this.messageQueue.length})`);
    this.dispatchToClaude(item.event, item.text);
  }

  // ========== Claude → 飞书（增量发送） ==========

  private handleClaudeResponse(text: string, isComplete: boolean, isYesNo?: boolean): void {
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;
    if (!text.trim()) return;

    // 启动前的 PTY 输出（-c 导致的残留）不发送到飞书
    if (!this.firstMessageReceived) {
      logger.debug(this.tag, `丢弃启动前输出: "${text.slice(0, 40)}"`);
      return;
    }

    // 用户消息回显去重（TUI 会回显用户输入，整行等于用户消息就跳过）
    if (this.lastUserMessage && text.trim() === this.lastUserMessage.trim()) {
      logger.debug(this.tag, `跳过用户消息回显: "${text.slice(0, 40)}"`);
      return;
    }

    if (!isComplete) {
      // 流式累积
      this.streamBuffer = text;
      // 每 5 秒增量发送一次（避免飞书限频）
      if (this.sendTimer) clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => {
        this.sendIncremental(targetChatId);
      }, this.SEND_INTERVAL_MS);
      return;
    }

    // === 完整回复 ===
    if (this.sendTimer) clearTimeout(this.sendTimer);

    const hasOptions = this.containsNumberedOptions(text);

    // yes/no 自动通过（仅无编号选项时）
    if (!hasOptions && this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
      const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(text));
      if (isDangerous) {
        this.sendRawText(targetChatId, `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`);
        this.waitingForAnswer = true;
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[31m⚠️ 危险操作！请手动确认（飞书或终端输入 yes/no）：\n${text}\x1b[0m\n`);
        }
        this.streamBuffer = '';
        return;
      }

      const approveMsg = `[自动通过] ${text}\n→ 已自动回复 yes`;
      this.sendRawText(targetChatId, approveMsg);
      if (!this.passthrough) {
        fs.writeSync(2, `\x1b[36m${approveMsg}\x1b[0m\n`);
      }
      setTimeout(() => { if (this.pty.isRunning()) this.pty.send('yes'); }, 500);
      this.streamBuffer = '';
      this.lastSentTextMap.delete(targetChatId);
      this.processQueue();
      return;
    }

    // 完成时：只发增量剩余部分（不发完整文本，避免重复）
    this.sendIncremental(targetChatId);
    this.streamBuffer = '';
    this.lastSentTextMap.delete(targetChatId);

    // 检查选项
    if (this.looksLikeQuestion(text)) {
      this.pendingOptions = [];
      if (this.optionTimer) clearTimeout(this.optionTimer);
      this.optionTimer = setTimeout(() => this.flushOptions(), 1500);
    } else {
      this.processQueue();
    }
  }

  private handleQuestion(options: string[]): void {
    if (!this.firstMessageReceived) return;
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;
    this.pendingOptions.push(...options);
    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.optionTimer = setTimeout(() => this.flushOptions(), 800);
  }

  private flushOptions(): void {
    this.optionTimer = null;
    if (this.pendingOptions.length === 0) { this.processQueue(); return; }

    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;

    const options = [...this.pendingOptions];
    this.pendingOptions = [];
    this.waitingForAnswer = true;

    const optionText = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
    const message = `📋 请回复编号选择：\n${optionText}`;

    this.sendRawText(targetChatId, message);
    if (!this.passthrough) {
      const terminal = ['', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📋 Claude 提问，请回复编号（飞书或终端均可）：', optionText,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ''].join('\n');
      fs.writeSync(2, `\x1b[33m${terminal}\x1b[0m\n`);
    }
  }

  // ========== 发送工具方法 ==========

  /**
   * 增量发送：和上次对比只发新增部分
   */
  private async sendIncremental(chatId: string): Promise<void> {
    const current = this.streamBuffer;
    if (!current.trim()) return;

    const lastSent = this.lastSentTextMap.get(chatId) || '';
    if (current === lastSent) return;

    let diff: string;
    if (lastSent && current.startsWith(lastSent)) {
      diff = current.substring(lastSent.length);
    } else {
      diff = current;
    }

    if (!diff.trim()) return;

    // 更新已发送记录
    this.lastSentTextMap.set(chatId, current);

    // 发送到飞书
    if (this.config.clone) {
      await this.sendPostMd(chatId, diff);
    } else {
      await this.sendRawText(chatId, diff);
    }

    logger.info(this.tag, `飞书 ← 增量 (${chatId}): +${diff.length}字 "${diff.slice(0, 60)}"`);
  }

  /** 发送纯文本（带限频保护） */
  private async sendRawText(chatId: string, text: string): Promise<void> {
    try {
      // 限频：两次发送至少间隔 1 秒
      const now = Date.now();
      const elapsed = now - this.lastSendTime;
      if (elapsed < 1000) {
        await new Promise(r => setTimeout(r, 1000 - elapsed));
      }
      this.lastSendTime = Date.now();

      await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: text.slice(0, 4000) }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    } catch (err: any) {
      // 限频错误静默，其他错误记录
      const msg = err?.response?.data?.msg || String(err);
      if (msg.includes('rate limit')) {
        logger.warn(this.tag, `飞书限频，跳过发送`);
      } else {
        logger.error(this.tag, `发送飞书失败: ${err}`);
      }
    }
  }

  /** 发送 post+md 富文本 */
  private async sendPostMd(chatId: string, text: string): Promise<void> {
    const maxBytes = 30 * 1024;
    const encoder = new TextEncoder();

    if (encoder.encode(text).length > maxBytes) {
      for (const chunk of this.splitText(text, maxBytes)) {
        await this.sendPostMdSingle(chatId, chunk);
      }
    } else {
      await this.sendPostMdSingle(chatId, text);
    }
  }

  private async sendPostMdSingle(chatId: string, text: string): Promise<void> {
    try {
      // 限频
      const now = Date.now();
      const elapsed = now - this.lastSendTime;
      if (elapsed < 1000) {
        await new Promise(r => setTimeout(r, 1000 - elapsed));
      }
      this.lastSendTime = Date.now();

      await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    } catch (err: any) {
      const msg = err?.response?.data?.msg || String(err);
      if (msg.includes('rate limit')) {
        logger.warn(this.tag, `飞书限频，跳过 post 发送`);
      } else {
        logger.error(this.tag, `飞书 post 失败，降级 text: ${err}`);
        await this.sendRawText(chatId, text);
      }
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
      } else { current = test; }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ========== 检测方法 ==========

  private isYesNoQuestion(text: string): boolean {
    const PERM_PATTERNS = [/requires approval/i, /do you want/i, /proceed/i,
      /\?\s*\[y\/n\]/i, /\?\s*\[Y\/n\]/, /\(yes\/no\)/i, /\(y\/n\)/i];
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

  private containsNumberedOptions(text: string): boolean {
    const lines = text.split('\n');
    let count = 0;
    for (const line of lines) {
      if (/^\s*\d{1,2}[.)]\s+/.test(line) || /^\s*[(（]\d{1,2}[)）]\s+/.test(line)) count++;
    }
    return count >= 2;
  }

  // ========== 持久化 ==========

  private saveChatId(chatId: string): void {
    const envPath = path.join(process.cwd(), '.env');
    const existing = this.config.chatIds || [];
    if (existing.includes(chatId)) return;

    const newChatIds = [...existing, chatId];
    this.config.chatIds = newChatIds;

    let envContent = '';
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf-8');

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
    logger.info(this.tag, `已保存 [${label}] chatId: ${chatId} (总计: ${newChatIds.length})`);
  }

  private parseMessageContent(messageType: string, content: string): string {
    if (!content) return '';
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') return parsed.text || '';
      return parsed.text || content;
    } catch { return content; }
  }

  stop(): void {
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (this.optionTimer) { clearTimeout(this.optionTimer); this.optionTimer = null; }
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
    this.pendingOptions = [];
    this.waitingForAnswer = false;
    this.messageQueue = [];
    this.claudeBusy = false;
    this.webServer.stop();
    this.pty.stop();
    if (this.passthrough) {
      try { process.stdin.setRawMode(false); process.stdin.pause(); } catch (_) {}
    }
    if (this.stdinRl) { this.stdinRl.close(); this.stdinRl = null; }
    this.wsClient = null;
    logger.info(this.tag, 'Bridge 已停止');
  }
}
