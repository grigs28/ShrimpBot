import * as fs from 'fs';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { PTYManager } from './pty-manager.js';
import { WebServer } from './web-server.js';
import { logger } from '../logger.js';
import { addChatId, loadShrimpBotConfig } from '../config.js';
import type { FeishuEvent, HookEvent } from '../types/index.js';

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
  /** 是否已收到第一条飞书消息（启动前的 PTY 输出不发送到飞书） */
  private firstMessageReceived = false;

  /** 最近发给 Claude 的用户消息（用于去重回显） */
  private lastUserMessage = '';

  private messageQueue: Array<{ event: FeishuEvent; text: string }> = [];
  private claudeBusy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 飞书发送队列：串行化所有发送，确保限频 */
  private sendQueue: Array<{ chatId: string; text: string; rich: boolean; label: string }> = [];
  private sendLock = false;
  private lastSendTime = 0;
  private readonly SEND_INTERVAL_MS = 2500; // 两次发送最小间隔（飞书：5条/10秒/会话）

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
        // Web/API 真正文本输入才触发飞书转发（排除终端探针等控制序列）
        if (!this.firstMessageReceived && /[^\x00-\x1f\x7f]/.test(data)) {
          this.firstMessageReceived = true;
          logger.info(this.tag, 'Web/API 输入触发，开始转发 Claude 输出');
        }
        this.pty.writeRaw(data);
      },
      getBufferText: () => this.pty.getBufferText(),
      getTerminalSize: () => this.pty.getTerminalSize(),
      botName: config.botName,
      onHookEvent: (event) => this.handleHookEvent(event),
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

    // 始终启动 Web 服务（hook API + 可选的终端 UI）
    const webPort = this.config.webPort || 5554;
    const portAvailable = await WebServer.isPortAvailable(webPort);
    if (portAvailable) {
      this.webServer.start();
      if (this.config.webEnabled) {
        logger.info(this.tag, `Web 终端已启动: http://localhost:${webPort}`);
      } else {
        logger.info(this.tag, `Hook API 已启动: http://localhost:${webPort}/api/hook`);
      }
    } else {
      logger.warn(this.tag, `端口 ${webPort} 已被占用，Hook API 和 Web 终端均未启动`);
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
      // 只有真正文本输入（非转义序列、非纯控制字符）才触发飞书转发
      if (!this.firstMessageReceived && /[^\x00-\x1f\x7f]/.test(input)) {
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
      this.enqueueSend(event.chatId, `⏳ 排队中（前面还有 ${this.messageQueue.length} 条消息）`, false, '排队通知');
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
      // 流式累积（只记录不发）
      this.streamBuffer = text;
      return;
    }

    // === 完整回复 ===

    const hasOptions = this.containsNumberedOptions(text);

    // yes/no 自动通过（仅无编号选项时）
    if (!hasOptions && this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
      const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(text));
      if (isDangerous) {
        this.enqueueSend(targetChatId, `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`, true, '危险操作警告');
        this.waitingForAnswer = true;
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[31m⚠️ 危险操作！请手动确认（飞书或终端输入 yes/no）：\n${text}\x1b[0m\n`);
        }
        this.streamBuffer = '';
        return;
      }

      const approveMsg = `[自动通过] ${text}\n→ 已自动回复 yes`;
      this.enqueueSend(targetChatId, approveMsg, true, '自动通过');
      if (!this.passthrough) {
        fs.writeSync(2, `\x1b[36m${approveMsg}\x1b[0m\n`);
      }
      setTimeout(() => { if (this.pty.isRunning()) this.pty.send('yes'); }, 500);
      this.streamBuffer = '';
      this.processQueue();
      return;
    }

    // 完成时：用 streamBuffer（累积的完整内容）而非 text（可能只是 ● 行）
    const fullText = this.streamBuffer || text;
    this.streamBuffer = '';

    // 发送完整回复（clone 和非 clone 都发，确保可靠性）
    // 非 clone 模式清洗 TUI 表格等，clone 模式原样发送
    if (fullText.trim()) {
      const sendText = this.config.clone ? fullText : this.cleanForMarkdown(fullText);
      this.enqueueSend(targetChatId, sendText, true, `完成: ${sendText.length}字`);
    }

    // 检查选项（clone 和非 clone 都需要）
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

    this.enqueueSend(targetChatId, message, false, '选项列表');
    if (!this.passthrough) {
      const terminal = ['', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📋 Claude 提问，请回复编号（飞书或终端均可）：', optionText,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ''].join('\n');
      fs.writeSync(2, `\x1b[33m${terminal}\x1b[0m\n`);
    }
  }

  // ========== 发送工具方法 ==========

  /**
   * 入队发送（所有飞书发送必须经过此方法，确保串行化+限频）
   */
  private enqueueSend(chatId: string, text: string, rich: boolean, label: string): void {
    this.sendQueue.push({ chatId, text, rich, label });
    logger.info(this.tag, `飞书 ← 入队 (${chatId}): ${label}`);
    this.drainSendQueue();
  }

  /**
   * 串行消费发送队列，每次发送间隔 SEND_INTERVAL_MS
   */
  private async drainSendQueue(): Promise<void> {
    if (this.sendLock) return;
    this.sendLock = true;

    while (this.sendQueue.length > 0) {
      const item = this.sendQueue.shift()!;

      // 限频等待
      const now = Date.now();
      const elapsed = now - this.lastSendTime;
      if (elapsed < this.SEND_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, this.SEND_INTERVAL_MS - elapsed));
      }
      this.lastSendTime = Date.now();

      try {
        if (item.rich) {
          await this.doSendPostMd(item.chatId, item.text);
        } else {
          await this.doSendRawText(item.chatId, item.text);
        }
        logger.info(this.tag, `飞书 ← 已发送 (${item.chatId}): ${item.label}`);
      } catch (err: any) {
        const msg = err?.response?.data?.msg || String(err);
        if (msg.includes('rate limit') || msg.includes('230020')) {
          logger.warn(this.tag, `飞书限频，等待 5 秒后重试`);
          await new Promise(r => setTimeout(r, 5000));
          // 重试一次
          try {
            if (item.rich) {
              await this.doSendPostMd(item.chatId, item.text);
            } else {
              await this.doSendRawText(item.chatId, item.text);
            }
          } catch (_) { /* 放弃 */ }
        } else {
          logger.error(this.tag, `发送飞书失败: ${err}`);
        }
      }
    }

    this.sendLock = false;
  }

  /** 实际发送纯文本（无限频逻辑，由 drainSendQueue 控制） */
  private async doSendRawText(chatId: string, text: string): Promise<void> {
    await this.feishuService.im.v1.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: text.slice(0, 4000) }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  /** 实际发送 post+md 富文本 */
  private async doSendPostMd(chatId: string, text: string): Promise<void> {
    const maxBytes = 30 * 1024;
    const encoder = new TextEncoder();

    if (encoder.encode(text).length > maxBytes) {
      for (const chunk of this.splitText(text, maxBytes)) {
        await this.doSendPostMdSingle(chatId, chunk);
      }
    } else {
      await this.doSendPostMdSingle(chatId, text);
    }
  }

  private async doSendPostMdSingle(chatId: string, text: string): Promise<void> {
    try {
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
        throw err; // 让 drainSendQueue 处理
      } else {
        logger.error(this.tag, `飞书 post 失败，降级 text: ${err}`);
        await this.doSendRawText(chatId, text);
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

  // ========== Hook 事件处理 ==========

  private handleHookEvent(event: HookEvent): void {
    if (!this.firstMessageReceived) return;
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) return;

    logger.info(this.tag, `Hook: ${event.hook_event_name}`);

    switch (event.hook_event_name) {
      case 'Stop': {
        if (event.stop_hook_active) return; // 防止循环
        // PTY 已经发送了完整回复，这里只触发 processQueue
        this.processQueue();
        break;
      }
      case 'Notification': {
        const msg = event.message || event.title || '';
        if (msg) {
          this.enqueueSend(targetChatId, `📢 ${msg}`, true, '通知');
        }
        break;
      }
      case 'PostToolUseFailure': {
        const toolName = event.tool_name || 'unknown';
        const error = event.error || '未知错误';
        this.enqueueSend(targetChatId, `❌ 工具失败 **${toolName}**: ${error}`, true, '工具失败');
        break;
      }
    }
  }

  private extractLastAssistantMessage(messages?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>): string {
    if (!messages || messages.length === 0) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === 'assistant') {
        const { content } = msg;
        if (typeof content === 'string') {
          return content.slice(0, 4000);
        }
        if (Array.isArray(content)) {
          return content
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => (b as { text: string }).text)
            .join('\n')
            .slice(0, 4000);
        }
      }
    }
    return '';
  }

  // ========== 文本清洗（非 clone 模式） ==========

  /** 清洗 TUI 表格等，转换为 Markdown 友好格式 */
  private cleanForMarkdown(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let inTable = false;
    let tableRows: string[] = [];

    for (const line of lines) {
      const t = line.trim();

      // 纯边框行（┌───┬───┐ 等）
      if (/^[╭╮╰╯┌┐└┘├┤┬┴┼─━═│┃]+$/.test(t)) {
        if (!inTable && tableRows.length > 0) {
          // 表格开始，标记
          inTable = true;
        }
        continue; // 跳过所有纯边框行
      }

      // 表格内容行（含 │ 分隔）→ 收集并转为 markdown 表格
      if (/^│.*│$/.test(t) || /^[|].*[|]$/.test(t)) {
        // 提取单元格
        const cells = t.split(/[│|]/).map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          tableRows.push('| ' + cells.join(' | ') + ' |');
          inTable = true;
          continue;
        }
      }

      // 非表格行：先把收集的表格输出
      if (inTable && tableRows.length > 0) {
        // 第一行后加分隔线
        if (tableRows.length >= 1) {
          const cols = tableRows[0]!.split('|').filter(Boolean).length;
          tableRows.splice(1, 0, '| ' + Array(cols).fill('---').join(' | ') + ' |');
        }
        result.push(...tableRows);
        result.push(''); // 表格后空行
        tableRows = [];
        inTable = false;
      }

      result.push(line);
    }

    // 末尾残余表格
    if (tableRows.length > 0) {
      if (tableRows.length >= 1) {
        const cols = tableRows[0]!.split('|').filter(Boolean).length;
        tableRows.splice(1, 0, '| ' + Array(cols).fill('---').join(' | ') + ' |');
      }
      result.push(...tableRows);
    }

    return result.join('\n');
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
    const existing = this.config.chatIds || [];
    if (existing.includes(chatId)) return;

    // 更新内存配置
    const newChatIds = [...existing, chatId];
    this.config.chatIds = newChatIds;

    // 写入 ~/.shrimpbot/config.json（不写 .env）
    addChatId(chatId);

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
