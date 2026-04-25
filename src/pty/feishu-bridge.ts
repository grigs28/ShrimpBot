import * as fs from 'fs';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { WebSocket as WS } from 'ws';
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
  private completionHandled = false;
  /** PTY ❯ 已出现（Claude 空闲），等待 Stop hook 带 transcript 完成卡片 */
  private ptyReady = false;
  /** PTY 完成时的兜底内容（Hook Stop 未触发时使用） */
  private fallbackPtyText = '';
  /** 最后一次 Hook Stop 传入的 transcript_path */
  private lastTranscriptPath = '';
  private lastAssistantMessage = '';
  /** 调试：已打印过 mentions 结构 */
  private _mentionDebugLogged = false;
  /** 是否已收到第一条飞书消息（启动前的 PTY 输出不发送到飞书） */
  private firstMessageReceived = false;
  /** 当前轮次是否已发过 Notification（"Claude is waiting" 只发一次） */
  private notificationSent = false;

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

  /** 远程 WebServer 连接（端口被占时通过 WebSocket 连接） */
  private remoteWebWs: WS | null = null;
  /** 是否已停止（防止 stop 后继续重连） */
  private stopped = false;

  /** Stop Hook 动态等待：PTY 输出停止更新时触发 */
  private stopHookTimer: ReturnType<typeof setTimeout> | null = null;
  /** 兜底完成 timer：8s 无新 Stop 自动完成 */
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STOP_HOOK_CHECK_INTERVAL_MS = 1000; // 检查间隔（1秒）
  private readonly STOP_HOOK_MAX_WAIT_MS = 15000; // 最长等待时间（15秒）
  private stopHookWaitStartTime = 0;

  /** 非 clone 模式：当前 interactive 卡片的 messageId（用于 patch 更新） */
  private currentCardId: string | null = null;
  private currentCardChatId: string | null = null;

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
        // Web/API Enter 提交命令 → 开始新一轮
        if (data.includes('\r') && this.completionHandled && this.firstMessageReceived) {
          this.handleExternalCommand();
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
      // 端口被占 → 连接到已有 WebServer 作为 bot 提供者
      logger.info(this.tag, `端口 ${webPort} 已被占用，连接到已有 WebServer`);
      try {
        await this.connectToRemoteWebServer(webPort);
        logger.info(this.tag, `已连接 WebServer，Hook API 代理: http://localhost:${webPort}/api/hook`);
      } catch (err: any) {
        logger.warn(this.tag, `无法连接 WebServer: ${err.message}，Web/Hook 不可用`);
      }
    }

    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const msg = data.message;
          const sender = data.sender;
          if (!msg) return;

          // 群聊消息：只处理 @当前机器人 或 @所有人 的消息（多 Bot 同群时过滤）
          const chatType = msg.chat_type || 'p2p';
          if (chatType === 'group') {
            const mentions: Array<Record<string, any>> = msg.mentions || [];
            const myAppId = this.config.feishuAppId;
            const myBotName = this.config.botName || '';

            // 调试日志
            logger.info(this.tag, `群聊消息 mentions=${JSON.stringify(mentions)} rawContent=${msg.content} (我=${myBotName})`);

            // 检查是否 @了所有人（飞书用 @_all 表示 @所有人，mentions 为空数组）
            const rawText = msg.content || '';
            const mentionAll = rawText.includes('@_all') ||
              mentions.some(m =>
                m?.id?.open_id === 'all' ||
                m?.key === 'all' ||
                m?.name === '所有人'
              );
            // 检查是否 @了当前机器人（用 name 匹配）
            const mentionedMe = mentions.some(m =>
              (myBotName && m?.name === myBotName) ||
              m?.id?.app_id === myAppId ||
              m?.id?.open_id === myAppId
            );
            if (!mentionAll && !mentionedMe) {
              logger.info(this.tag, `群聊消息未 @我(${myBotName})，忽略`);
              return;
            }
          }

          const event: FeishuEvent = {
            chatId: msg.chat_id,
            chatType,
            userId: sender?.sender_id?.open_id || '',
            messageId: msg.message_id,
            text: this.parseMessageContent(msg.message_type, msg.content, msg.mentions),
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
      if (!this.firstMessageReceived && /[^\x00-\x1f\x7f]/.test(input)) {
        this.firstMessageReceived = true;
        logger.info(this.tag, '终端输入触发，开始转发 Claude 输出');
      }
      // 终端 Enter 提交命令 → 开始新一轮（飞书三端同步）
      if (input.includes('\r') && this.completionHandled && this.firstMessageReceived) {
        this.handleExternalCommand();
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
    this.completionHandled = false;
    this.ptyReady = false;
    this.notificationSent = false;
    this.streamBuffer = '';
    this.fallbackPtyText = '';
    this.lastTranscriptPath = '';
    this.lastAssistantMessage = '';
    if (this.stopHookTimer) { clearTimeout(this.stopHookTimer); this.stopHookTimer = null; }
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null; }

    const chatLabel = event.chatType === 'p2p' ? '私聊' : '群聊';
    logger.info(this.tag, `[${chatLabel}] 飞书 → Claude: "${text.slice(0, 100)}" (${event.chatId})`);

    this.pendingOptions = [];
    if (this.optionTimer) clearTimeout(this.optionTimer);
    this.claudeBusy = true;

    // 非 clone 模式：发 🔵 思考中卡片
    if (!this.config.clone) {
      this.sendThinkingCard(event.chatId);
    }

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

  /** 终端/Web 输入提交命令 → 开始新一轮（三端同步） */
  private handleExternalCommand(): void {
    const chatId = this.responseChatId || this.defaultChatId;
    if (!chatId) return;

    // 清理上一轮的 timer
    if (this.stopHookTimer) { clearTimeout(this.stopHookTimer); this.stopHookTimer = null; }
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null; }

    // 重置状态
    this.completionHandled = false;
    this.ptyReady = false;
    this.notificationSent = false;
    this.streamBuffer = '';
    this.fallbackPtyText = '';
    this.lastTranscriptPath = '';
    this.lastAssistantMessage = '';

    // 非 clone 模式发思考卡片
    if (!this.config.clone) {
      this.sendThinkingCard(chatId);
    }

    this.claudeBusy = true;

    // 安全超时
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      if (this.claudeBusy) {
        logger.warn(this.tag, '⏰ 外部输入响应超时（120s），强制解除 claudeBusy');
        this.processQueue();
      }
    }, 120_000);

    logger.info(this.tag, `外部输入开始新一轮: chatId=${chatId}`);
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
      // 流式累积（只记录不发，完成后停止更新防止覆盖）
      if (!this.completionHandled) {
        // 优先用 PTY buffer（包含表格等未 flush 内容）
        const bufferText = this.pty.getBufferText();
        this.streamBuffer = bufferText || text;
        // 流式更新 fallbackPtyText，确保 Stop hook 在完成前触发时也有当前轮内容
        this.fallbackPtyText = text;
      }
      return;
    }

    // === 完整回复 ===

    // 防双重 patch：Stop hook 或 doFinalPatch 可能已处理过
    if (this.completionHandled) {
      this.streamBuffer = '';
      return;
    }

    const hasOptions = this.containsNumberedOptions(text);

    // yes/no 自动通过（仅无编号选项时）
    if (!hasOptions && this.config.autoApprove !== false && (isYesNo || this.isYesNoQuestion(text))) {
      const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(text));
      if (isDangerous) {
        this.completionHandled = true;
        if (this.config.clone) {
          this.enqueueSend(targetChatId, `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`, true, '危险操作警告');
        } else {
          this.patchCard('red', '🔴 危险操作', `⚠️ 检测到潜在危险操作，需要手动确认：\n${text}`);
        }
        this.waitingForAnswer = true;
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[31m⚠️ 危险操作！请手动确认（飞书或终端输入 yes/no）：\n${text}\x1b[0m\n`);
        }
        this.streamBuffer = '';
        return;
      }

      const approveMsg = `[自动通过] ${text}\n→ 已自动回复 yes`;
      // 自动通过不设 completionHandled，Claude 发 yes 后继续工作，最终 ❯ 才触发 doFinalPatch
      if (this.config.clone) {
        this.enqueueSend(targetChatId, approveMsg, true, '自动通过');
      } else {
        this.patchCard('green', '🟢 自动通过', approveMsg);
      }
      if (!this.passthrough) {
        fs.writeSync(2, `\x1b[36m${approveMsg}\x1b[0m\n`);
      }
      setTimeout(() => { if (this.pty.isRunning()) this.pty.send('yes'); }, 500);
      this.streamBuffer = '';
      this.processQueue();
      return;
    }

    const fullText = text || this.streamBuffer;
    this.streamBuffer = '';

    if (this.config.clone) {
      // clone 模式：直接发新消息
      this.completionHandled = true;
      if (fullText.trim()) {
        this.enqueueSend(targetChatId, fullText, true, `完成: ${fullText.length}字`);
      }
    } else {
      // 非 clone 模式：❯ 只标记 PTY 就绪，等 Stop hook 带 transcript 完成卡片
      this.ptyReady = true;
      this.fallbackPtyText = fullText;
      logger.info(this.tag, `PTY ❯ 就绪 (${fullText.length}字), 等 Stop hook`);
      // 如果 Stop 已经先到了（已有 transcript），立即完成
      if (this.lastTranscriptPath && !this.completionHandled) {
        if (this.stopHookTimer) clearTimeout(this.stopHookTimer);
        this.doFinalPatch();
      }
      return;
    }

    // clone 模式后续：检查选项
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

    if (this.config.clone) {
      this.enqueueSend(targetChatId, message, false, '选项列表');
    } else {
      this.patchCard('yellow', '🟡 等待选择', message);
    }
    if (!this.passthrough) {
      const terminal = ['', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📋 Claude 提问，请回复编号（飞书或终端均可）：', optionText,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ''].join('\n');
      fs.writeSync(2, `\x1b[33m${terminal}\x1b[0m\n`);
    }
  }

  // ========== 发送工具方法 ==========

  // ========== 非 clone 模式：Interactive 卡片 ==========

  /** 发送 🔵 思考中卡片（用户提问时） */
  private async sendThinkingCard(chatId: string): Promise<void> {
    this.currentCardId = null;
    this.currentCardChatId = chatId;
    try {
      const resp = await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard('blue', '🔵 思考中...', '')),
        },
        params: { receive_id_type: 'chat_id' },
      });
      this.currentCardId = resp.data?.message_id || null;
      logger.info(this.tag, `🔵 思考中卡片已发送: ${this.currentCardId}`);
    } catch (err) {
      logger.error(this.tag, `发送思考卡片失败: ${err}`);
    }
  }

  /** Patch 当前卡片（完成/进度/选项）
   *  只有最终完成（🟢）或选项（🟡）才清掉 currentCardId
   *  进度更新（🔄）保持 currentCardId，允许后续继续更新
   */
  private async patchCard(color: string, title: string, content: string, keepAlive = false): Promise<void> {
    const chatId = this.currentCardChatId || this.responseChatId || this.defaultChatId;
    if (!chatId) return;

    // 截断到 28K
    const truncated = content.length > 28000
      ? content.slice(0, 14000) + '\n\n... (内容过长已截断) ...\n\n' + content.slice(-14000)
      : content;

    // 有 messageId → patch
    if (this.currentCardId) {
      try {
        await this.feishuService.im.v1.message.patch({
          path: { message_id: this.currentCardId },
          data: { content: JSON.stringify(this.buildCard(color, title, truncated)) },
        });
        logger.info(this.tag, `卡片已更新: ${title}`);
        if (!keepAlive) {
          this.currentCardId = null;
          this.currentCardChatId = null;
        }
        return;
      } catch (err) {
        logger.warn(this.tag, `Patch 卡片失败，降级发新消息: ${err}`);
        this.currentCardId = null;
      }
    }

    // 无 messageId 或 patch 失败 → 发新卡片
    try {
      const resp = await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard(color, title, truncated)),
        },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info(this.tag, `新卡片已发送: ${title} (${resp.data?.message_id})`);
    } catch (err) {
      // 最后降级纯文本
      logger.warn(this.tag, `卡片发送失败，降级 text: ${err}`);
      this.enqueueSend(chatId, `${title}\n${truncated.slice(0, 4000)}`, false, title);
    }
    this.currentCardId = null;
    this.currentCardChatId = null;
  }

  /** 发送独立的交互式卡片（不影响 currentCardId，不 patch 现有卡片） */
  private async sendIndependentCard(chatId: string, color: string, title: string, content: string): Promise<void> {
    const truncated = content.length > 28000
      ? content.slice(0, 14000) + '\n\n... (内容过长已截断) ...\n\n' + content.slice(-14000)
      : content;
    try {
      await this.feishuService.im.v1.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(this.buildCard(color, title, truncated)),
        },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info(this.tag, `独立卡片已发送: ${title}`);
    } catch (err) {
      logger.warn(this.tag, `独立卡片发送失败，降级文本: ${err}`);
      this.enqueueSend(chatId, `${title}\n${truncated.slice(0, 4000)}`, true, title);
    }
  }

  /** 构建飞书 interactive 卡片 JSON
   *  自动检测 markdown 表格并转为飞书原生 table 组件
   */
  private buildCard(color: string, title: string, content: string): Record<string, unknown> {
    const card: Record<string, unknown> = {
      config: { wide_screen_mode: true },
      header: {
        template: color,
        title: { content: title, tag: 'plain_text' },
      },
      elements: [] as Record<string, unknown>[],
    };
    const elements = card.elements as Record<string, unknown>[];

    if (!content) return card;

    // 尝试提取 markdown 表格并转为飞书原生 table 组件
    const parts = this.splitTableContent(content);
    for (const part of parts) {
      if (part.type === 'table') {
        elements.push(part.tableJson!);
      } else {
        const text = part.text.trim();
        if (text) elements.push({ tag: 'markdown', content: text });
      }
    }

    return card;
  }

  /** 将内容拆分为 text 段和 table 段 */
  private splitTableContent(content: string): Array<{ type: 'text'; text: string } | { type: 'table'; tableJson: Record<string, unknown> }> {
    const lines = content.split('\n');
    const result: Array<{ type: 'text'; text: string } | { type: 'table'; tableJson: Record<string, unknown> }> = [];
    let textBuffer: string[] = [];

    const flushText = () => {
      if (textBuffer.length > 0) {
        result.push({ type: 'text', text: textBuffer.join('\n') });
        textBuffer = [];
      }
    };

    // 检测 markdown 表格：| ... | 格式，紧跟 | --- | 分隔行
    const MD_TABLE_ROW = /^\s*\|.*\|\s*$/;
    const MD_TABLE_SEP = /^\s*\|[\s\-:]+\|/;

    let i = 0;
    while (i < lines.length) {
      // 找表头行
      if (MD_TABLE_ROW.test(lines[i]!) && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]!)) {
        const headerLine = lines[i]!.trim();
        i += 2; // 跳过表头和分隔行

        // 收集数据行
        const dataLines: string[] = [];
        while (i < lines.length && MD_TABLE_ROW.test(lines[i]!)) {
          dataLines.push(lines[i]!.trim());
          i++;
        }

        // 解析表格
        const tableJson = this.parseMdTable(headerLine, dataLines);
        if (tableJson) {
          flushText();
          result.push({ type: 'table', tableJson });
          continue;
        }
        // 解析失败，当作普通文本
        textBuffer.push(headerLine);
      }

      textBuffer.push(lines[i]!);
      i++;
    }

    flushText();
    return result;
  }

  /** 解析 markdown 表格为飞书 table 组件 JSON */
  private parseMdTable(headerLine: string, dataLines: string[]): Record<string, unknown> | null {
    const parseCells = (line: string): string[] =>
      line.split('|').map(c => c.trim()).filter(Boolean);

    const headers = parseCells(headerLine);
    if (headers.length < 2) return null;

    // 列定义：用下标作为 name
    const columns = headers.map((h, idx) => ({
      name: `col_${idx}`,
      display_name: h,
      data_type: 'text' as string,
      width: 'auto' as string,
    }));

    // 行数据
    const rows = dataLines.map(line => {
      const cells = parseCells(line);
      const row: Record<string, string> = {};
      columns.forEach((_, idx) => {
        row[`col_${idx}`] = cells[idx] || '';
      });
      return row;
    });

    if (rows.length === 0) return null;

    return {
      tag: 'table',
      page_size: Math.min(rows.length, 5),
      row_height: 'low',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        bold: true,
      },
      columns,
      rows,
    };
  }

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
        if (event.transcript_path) this.lastTranscriptPath = event.transcript_path;
        if (event.last_assistant_message) this.lastAssistantMessage = event.last_assistant_message;
        logger.info(this.tag, `Hook Stop: completionHandled=${this.completionHandled}, ptyReady=${this.ptyReady}, hookMsg=${(event.last_assistant_message || '').length}字`);
        // 非 clone 模式：Stop 驱动完成卡片
        if (!this.config.clone && !this.completionHandled) {
          // PTY 已就绪（❯ 已到）→ 立即完成（不再等 debounce）
          if (this.ptyReady && this.lastTranscriptPath) {
            if (this.stopHookTimer) clearTimeout(this.stopHookTimer);
            if (this.completionTimer) clearTimeout(this.completionTimer);
            this.doFinalPatch();
            return;
          }
          // PTY 未就绪 → 中间 Stop，debounce 3s 更新进度
          if (this.stopHookTimer) clearTimeout(this.stopHookTimer);
          this.stopHookTimer = setTimeout(() => {
            if (this.completionHandled) { this.processQueue(); return; }
            const hookMsg = (this.lastAssistantMessage || '').trim();
            const bufferText = this.pty.getBufferText().trim();
            const content = hookMsg || bufferText;
            logger.info(this.tag, `Hook Stop (进度): ${content.length}字 (hook=${hookMsg.length}, buffer=${bufferText.length})`);
            if (content.trim() && this.currentCardId) {
              this.patchCard('blue', '🔄 处理中', content, true);
            }
          }, 3000);
          // 兜底：如果 ❯ 一直没来，8s 后自动完成
          if (this.completionTimer) clearTimeout(this.completionTimer);
          this.completionTimer = setTimeout(() => {
            if (!this.completionHandled) {
              logger.info(this.tag, `Hook Stop 兜底完成 (8s)`);
              this.doFinalPatch();
            }
          }, 8000);
          return;
        }
        this.processQueue();
        break;
      }
      case 'Notification': {
        const msg = event.message || event.title || '';
        if (msg && !this.notificationSent) {
          this.notificationSent = true;
          this.sendIndependentCard(targetChatId, 'orange', '📢 通知', msg);
        }
        break;
      }
      case 'PostToolUseFailure': {
        const toolName = event.tool_name || 'unknown';
        const error = event.error || '未知错误';
        if (event.transcript_path) this.lastTranscriptPath = event.transcript_path;
        // 优先从 transcript 读取完整内容
        let content = this.readLastAssistantFromTranscript(this.lastTranscriptPath);
        if (!content.trim()) content = error;
        this.sendIndependentCard(targetChatId, 'red', `❌ 工具失败: ${toolName}`, content);
        break;
      }
    }
  }

  /** 从 transcript JSONL 文件读取最后一条 assistant 消息
   *  transcript 结构：每行 JSON，type="assistant" 的行有 message.role="assistant"
   *  内容在 message.content 数组里（{type:"text", text:"..."} 和 {type:"tool_use", ...}）
   */
  private readLastAssistantFromTranscript(transcriptPath?: string): string {
    if (!transcriptPath) return '';
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);

      // 从后往前找最后一条有实质内容的 assistant 消息
      // 跳过 "No response requested." 等空回复
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]!);
          if (entry.type === 'assistant' && entry.message) {
            const msg = entry.message;
            const content = msg.content;
            if (typeof content === 'string') {
              if (content.trim().length > 50) return content;
              continue; // 太短，跳过
            }
            if (Array.isArray(content)) {
              const texts = content
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text as string);
              const joined = texts.join('\n').trim();
              // 跳过空回复和无实质内容
              if (joined.length > 50 && !/^no response/i.test(joined)) return joined;
            }
          }
        } catch { /* 跳过解析失败的行 */ }
      }
    } catch (err) {
      logger.warn(this.tag, `读取 transcript 失败: ${err}`);
    }
    return '';
  }

  // ========== 文本清洗（非 clone 模式） ==========

  /** 清洗 TUI 输出，转换为 Markdown 友好格式
   * 注意：OutputParser 已经把 TUI 表格转为 markdown，这里只做简单清理
   */
  private cleanForMarkdown(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      const t = line.trim();

      // 跳过纯边框行（┌───┬───┐ 等）—— OutputParser 已处理表格
      if (/^[╭╮╰╯┌┐└┘├┤┬┴┼─━═│┃]+$/.test(t)) {
        continue;
      }

      // 跳过已经是 markdown 分隔线的重复行
      if (/^\|\s*[-:]+\s*\|/.test(t) && result.length > 0) {
        const lastLine = result[result.length - 1]!.trim();
        if (/^\|\s*[-:]+\s*\|/.test(lastLine)) {
          continue; // 跳过重复的分隔线
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /** 最终 patch：优先用 Stop hook 的 last_assistant_message */
  private doFinalPatch(): void {
    if (this.completionHandled) return;
    this.completionHandled = true;
    if (this.stopHookTimer) { clearTimeout(this.stopHookTimer); this.stopHookTimer = null; }
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null; }
    // 优先级：last_assistant_message > PTY buffer > parser
    const hookMsg = (this.lastAssistantMessage || '').trim();
    const bufferText = this.pty.getBufferText().trim();
    const ptyText = (this.fallbackPtyText || '').trim();
    const content = hookMsg || bufferText || ptyText;
    const source = hookMsg ? 'hook' : bufferText ? 'buffer' : 'pty';
    logger.info(this.tag, `最终 patch: ${content.length}字 (source=${source}, hook=${hookMsg.length}, buffer=${bufferText.length}, pty=${ptyText.length})`);
    if (content.trim()) {
      this.patchCard('green', '🟢 完成', content);
    }
    this.processQueue();
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

  /**
   * 解析飞书消息内容，清理 @mention 占位符
   * 飞书会把 @用户名 替换为 @_user_N 占位符，需要还原为实际名字
   */
  private parseMessageContent(messageType: string, content: string, mentions?: Array<Record<string, any>>): string {
    if (!content) return '';
    try {
      const parsed = JSON.parse(content);
      let text = parsed.text || '';
      if (!text) return content;

      // 替换 @_user_N 占位符为实际名字
      if (mentions && mentions.length > 0) {
        for (let i = 0; i < mentions.length; i++) {
          const m = mentions[i];
          const placeholder = m?.key || `_user_${i + 1}`;
          const name = m?.name || '';
          // 把 @_user_N 替换为 @名字，如果名字是"所有人"则去掉
          if (name === '所有人') {
            text = text.replace(new RegExp(`@${placeholder}\\s*`, 'g'), '');
          } else if (name) {
            text = text.replace(new RegExp(`@${placeholder}`, 'g'), `@${name}`);
          } else {
            text = text.replace(new RegExp(`@${placeholder}\\s*`, 'g'), '');
          }
        }
      }

      // 清理残留的 @_user_N 占位符和 @_all（@所有人）
      text = text.replace(/@_user_\d+\s*/g, '');
      text = text.replace(/@_all\s*/g, '');

      return text.trim();
    } catch { return content; }
  }

  /** 连接到远程 WebServer 作为 bot 提供者（PTY 数据推送 + Web 输入接收 + Hook 事件接收） */
  private connectToRemoteWebServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const botId = this.config.botName || 'ShrimpBot';
      let reconnectDelay = 1000;
      let settled = false;

      const connect = () => {
        const ws = new WS(`ws://127.0.0.1:${port}/ws/bot`);

        ws.on('open', () => {
          // 标识自己
          ws.send(JSON.stringify({ type: 'bot-join', name: botId }));
          reconnectDelay = 1000; // 连接成功，重置重连间隔

          // PTY 数据 → 远程 WebServer → 浏览器（附带 botName）
          this.pty.onRawData((data: string) => {
            if (ws.readyState === WS.OPEN) {
              ws.send(JSON.stringify({ type: 'pty-data', data, name: botId }));
            }
          });

          if (!settled) { settled = true; resolve(); }
        });

        ws.on('message', (msg: Buffer) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'web-input' && typeof parsed.data === 'string') {
              // 过滤非目标 bot 的消息（多咪时只处理发给自己的）
              if (parsed.targetBot && parsed.targetBot !== botId) return;
              // Web 输入 → PTY
              if (!this.firstMessageReceived && /[^\x00-\x1f\x7f]/.test(parsed.data)) {
                this.firstMessageReceived = true;
                logger.info(this.tag, 'Web 输入触发，开始转发 Claude 输出');
              }
              if (parsed.data.includes('\r') && this.completionHandled && this.firstMessageReceived) {
                this.handleExternalCommand();
              }
              this.pty.writeRaw(parsed.data);
            } else if (parsed.type === 'hook' && parsed.event) {
              // Hook 事件 → 本地处理
              this.handleHookEvent(parsed.event as HookEvent);
            }
          } catch { /* ignore */ }
        });

        ws.on('error', (err) => {
          if (!settled) { settled = true; reject(err); return; }
          logger.warn(this.tag, `WebServer 连接错误: ${err.message}`);
        });

        ws.on('close', () => {
          this.remoteWebWs = null;
          logger.warn(this.tag, `与 WebServer 的连接已断开，${reconnectDelay / 1000}s 后重连`);
          // 自动重连（指数退避，最大 30s）
          setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            if (!this.stopped) connect();
          }, reconnectDelay);
        });

        this.remoteWebWs = ws;
      };

      connect();

      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('连接超时')); }
      }, 5000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (this.optionTimer) { clearTimeout(this.optionTimer); this.optionTimer = null; }
    if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = null; }
    if (this.stopHookTimer) { clearTimeout(this.stopHookTimer); this.stopHookTimer = null; }
    if (this.completionTimer) { clearTimeout(this.completionTimer); this.completionTimer = null; }
    this.pendingOptions = [];
    this.waitingForAnswer = false;
    this.messageQueue = [];
    this.claudeBusy = false;
    if (this.remoteWebWs) { this.remoteWebWs.close(); this.remoteWebWs = null; }
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
