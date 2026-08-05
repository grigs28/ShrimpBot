import * as fs from 'fs';
import * as readline from 'readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { WebSocket as WS } from 'ws';
import { PTYManager } from './pty-manager.js';
import { WebServer } from './web-server.js';
import { logger } from '../logger.js';
import { addChatId, loadShrimpBotConfig } from '../config.js';
import type { FeishuEvent, HookEvent } from '../types/index.js';
import { SDKSession } from '../sdk/sdk-session.js';
import { FeishuCardRenderer } from '../sdk/feishu-card-renderer.js';
import type { SDKBridgeEvent, ApprovalRequest, PermissionResult } from '../sdk/sdk-types.js';

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
  /** 远程 WebServer 地址（如 192.168.0.19:5554），配置后直连不启动本地 */
  webHost?: string;
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
  /** 流式阶段已发送权限确认卡片，防止重复 */
  private permissionNotified = false;
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
  /** 思考卡片轮次 ID（防止旧异步调用覆盖新轮次） */
  private _thinkingRoundId = 0;

  private responseChatId = '';
  private defaultChatId = '';
  private knownChats = new Map<string, ChatInfo>();

  // ========== SDK 模式（feature flag SDK_EVENT_MODE=true） ==========
  /** SDK 会话（封装 Claude Agent SDK 的 query/resume） */
  private sdkSession: SDKSession | null = null;
  /** SDK 事件 → 飞书卡片渲染器 */
  private sdkRenderer: FeishuCardRenderer | null = null;
  /** 是否启用 SDK 模式（SDK_EVENT_MODE === 'true'） */
  private sdkMode: boolean = false;
  /** 方案 C：SDK 模式下 Web 广播回调（SDK 事件 → Web xterm，替代 PTY raw） */
  private sdkWebBroadcast: ((data: string) => void) | null = null;
  /**
   * A2：等待飞书回复的 AskUserQuestion 审批（toolUseId → { resolve, questions, timer }）。
   * 裁决 1：resolve 的 outcome 为完整 PermissionResult（allow/deny 两条路径共用）。
   * 裁决 2：存 questions + timer，便于回复路径解析答案并 clearTimeout（避免回复后超时仍触发 deny）。
   * AskUserQuestion 串行：同时只有一个挂起审批。
   */
  private pendingQuestions = new Map<string, {
    resolve: (outcome: PermissionResult) => void;
    questions: any[];
    timer: NodeJS.Timeout;
  }>();

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
      onPtyData: (cb) => {
        // 方案 C：SDK 模式 Web 显示 SDK 事件（非 PTY raw），cb 存为 SDK 广播目标；
        // PTY 模式 cb 绑 PTY raw（原行为）
        if (this.sdkMode) {
          this.sdkWebBroadcast = cb;
        } else {
          this.pty.onRawData(cb);
        }
      },
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
      cwd: config.claudeCwd,
      onHookEvent: (event) => this.handleHookEvent(event),
      yzLoginUrl: process.env.YZ_LOGIN_URL,
      noAuth: process.env.WEB_NO_AUTH === 'true',
    }, config.webPort || 5554);

    this.pty.onEvent((event) => {
      if (event.type === 'response') {
        this.handleClaudeResponse(event.text, event.isComplete, event.isYesNo);
      } else if (event.type === 'question') {
        this.handleQuestion(event.options);
      } else if (event.type === 'error') {
        const targetChatId = this.responseChatId || this.defaultChatId;
        if (targetChatId) {
          const msg = `🔴 PTY 崩溃恢复失败\n${event.error.message}\nBot 已停止响应，请重新启动 sbot`;
          if (this.config.clone) {
            this.enqueueSend(targetChatId, msg, false, 'PTY错误');
          } else {
            this.sendIndependentCard(targetChatId, 'red', '🔴 PTY 错误', event.error.message);
          }
        }
        logger.error(this.tag, `PTY 错误: ${event.error.message}`);
      } else if (event.type === 'exit') {
        const targetChatId = this.responseChatId || this.defaultChatId;
        if (targetChatId) {
          const msg = `🔴 Claude 进程已退出（code=${event.code}）\nBot 正在关闭，请重新启动 sbot`;
          if (this.config.clone) {
            this.enqueueSend(targetChatId, msg, false, 'PTY退出');
          } else {
            this.sendIndependentCard(targetChatId, 'red', '🔴 进程退出', `Claude 进程已退出（code=${event.code}），请重新启动 sbot`);
          }
        }
        logger.info(this.tag, `Claude PTY 退出: code=${event.code}，关闭 Bridge`);
        this.stop();
        // 给飞书发送留 2s 时间再退出
        setTimeout(() => process.exit(event.code || 0), 2000);
      }
    });

    // SDK 模式初始化（feature flag：SDK_EVENT_MODE === 'true'）
    this.sdkMode = process.env.SDK_EVENT_MODE === 'true';
    if (this.sdkMode) {
      const sdkCwd = this.config.claudeCwd || process.cwd();
      this.sdkSession = new SDKSession(sdkCwd);
      this.sdkRenderer = new FeishuCardRenderer();
      logger.info(this.tag, `SDK 模式已启用 (cwd: ${sdkCwd})`);
    }
  }

  async start(): Promise<void> {
    this.pty.start();

    const webHost = this.config.webHost;
    if (webHost) {
      // 有远程地址 → 直连，连不上跳过
      logger.info(this.tag, `配置了远程 WebServer: ${webHost}，尝试连接...`);
      try {
        await this.connectToRemoteWebServer(webHost);
        logger.info(this.tag, `已连接远程 WebServer: ${webHost}`);
      } catch (err: any) {
        logger.warn(this.tag, `无法连接远程 WebServer ${webHost}: ${err.message}，Web/Hook 不可用`);
      }
    } else {
      // 无远程地址 → 现有逻辑
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
        logger.info(this.tag, `端口 ${webPort} 已被占用，连接到已有 WebServer`);
        try {
          await this.connectToRemoteWebServer(webPort);
          logger.info(this.tag, `已连接 WebServer，Hook API 代理: http://localhost:${webPort}/api/hook`);
        } catch (err: any) {
          logger.warn(this.tag, `无法连接 WebServer: ${err.message}，Web/Hook 不可用`);
        }
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

            // 检查是否 @了所有人（飞书 @所有人 content 占位符：旧 @_all / 新 @all / 文本 @所有人）
            const rawText = msg.content || '';
            const mentionAll = rawText.includes('@_all') || rawText.includes('@all') || rawText.includes('@所有人') ||
              mentions.some(m =>
                m?.id?.open_id === 'all' ||
                m?.key === 'all' || m?.key === '@_all' || m?.key === '@all' ||
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

    // A2：优先处理 AskUserQuestion 审批回复（串行，同时只有一个挂起）。
    // 命中后立即 return，不走正常 dispatch，避免把 "1" 发给 claude 当新消息。
    if (this.pendingQuestions.size > 0) {
      const entry = this.pendingQuestions.entries().next().value;
      if (entry) {
        const [toolUseId, pending] = entry;
        const q = pending.questions?.[0] || {};
        const opts: any[] = q.options || [];
        let answer = text;
        if (/^\d+$/.test(text)) {
          const idx = parseInt(text, 10) - 1;
          if (opts[idx]) answer = String(opts[idx].label);
        } else {
          const match = opts.find((o: any) => o.label === text);
          if (match) answer = String(match.label);
        }
        clearTimeout(pending.timer);
        this.pendingQuestions.delete(toolUseId);
        logger.info(this.tag, `[${chatLabel}] AskUserQuestion 回复: "${text}" → "${answer}" (${event.chatId})`);
        pending.resolve({
          behavior: 'allow',
          updatedInput: { questions: pending.questions, answers: { [q.question || '']: answer } },
        });
        return;
      }
    }

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

  // ========== SDK 模式：通过 Claude Agent SDK 派发 ==========

  /**
   * 方案 C：把 SDK 事件格式化为文本广播到 Web xterm（SDK 模式 Web 显示 SDK 事件，非 PTY raw）。
   * 飞书 + Web 同一 SDK claude，实时同步。
   */
  private broadcastSdkToWeb(event: SDKBridgeEvent): void {
    if (!this.sdkWebBroadcast) return;
    let text = '';
    switch (event.type) {
      case 'text': text = event.text + '\r\n'; break;
      case 'tool_use': text = `🛠 ${event.toolName}: ${JSON.stringify(event.input).slice(0, 80)}\r\n`; break;
      case 'completed': text = (event.text || '') + '\r\n'; break;
      case 'error': text = `🔴 ${event.message}\r\n`; break;
      // tool_result / approval_request / init 不广播（噪声或无文本）
    }
    if (text) this.sdkWebBroadcast(text);
  }

  /**
   * SDK 路径派发（仅 SDK_EVENT_MODE=true 时调用）。
   * 与旧 PTY 路径并行，不经 PTYManager，直接消费 SDKSession 事件流并 patch 飞书卡片。
   * 自管理 claudeBusy 生命周期（start=true / finally=false + processQueue）。
   */
  private async dispatchToClaudeViaSDK(text: string, targetChatId: string): Promise<void> {
    if (!this.sdkSession || !this.sdkRenderer) return;

    this.claudeBusy = true;
    this.responseChatId = targetChatId;
    this.sdkRenderer.reset();

    // 思考卡片（非 clone 模式才有意义，sendThinkingCard 内部已处理卡片发送）
    if (!this.config.clone) {
      this.sendThinkingCard(targetChatId);
    }

    try {
      // cwd 已在 SDKSession 构造时设定，此处不再传入（SDKSessionOptions 无 cwd 字段）
      const events = this.sdkSession.start(text, {
        permissionMode: 'default',
        // clone 模式不弹审批（透传），非 clone 阶段 A 直接 allow（与旧路径行为兼容）
        // TODO: 阶段 B 接入 ApprovalGate 飞书交互卡片
        onApproval: this.config.clone ? undefined : async (req: ApprovalRequest): Promise<PermissionResult> => {
          logger.info(this.tag, `审批请求: ${req.toolName} ${JSON.stringify(req.input).slice(0, 100)}`);
          return { behavior: 'allow' };
        },
      });

      for await (const event of events) {
        // 方案 C：SDK 事件广播到 Web xterm（飞书+Web 同一 SDK claude，实时同步）
        this.broadcastSdkToWeb(event);
        if (event.type === 'completed') {
          this.sdkRenderer!.addEvent(event);
          const card = this.sdkRenderer!.finalize();
          // 终态卡片：若 renderer 未累积到文本（仅有 completed 自带 text），兜底用事件文本
          const content = card.content || event.text;
          this.patchCard(card.color, card.header, content);
          break;
        } else if (event.type === 'error') {
          this.sdkRenderer!.addEvent(event);
          const card = this.sdkRenderer!.finalize();
          this.patchCard('red', '🔴 错误', card.content);
          break;
        } else if (event.type === 'approval_request') {
          // 阶段 A：不渲染独立审批卡片，由 onApproval 回调直接 allow
          // 这里不 patch 卡片，避免与 onApproval 的并发 patch 竞争
          continue;
        } else {
          // 流式中间态（text / tool_use / tool_result）
          const shouldPatch = this.sdkRenderer!.addEvent(event);
          if (shouldPatch && !this.config.clone) {
            const card = this.sdkRenderer!.getIntermediate();
            this.patchCard(card.color, card.header, card.content);
          }
        }
      }
    } catch (err: any) {
      const detail = err?.message ? String(err.message) : String(err);
      logger.error(this.tag, `SDK dispatch 异常: ${detail}`);
      this.patchCard('red', '🔴 错误', detail);
    } finally {
      this.claudeBusy = false;
      this.processQueue();
    }
  }

  /**
   * A2：收到 hub 转发的 AskUserQuestion 选项请求（WS approval-request）。
   * 渲染飞书选项卡片 → 等用户飞书文本回复（编号或选项名，在 handleFeishuMessage 里路由回来）
   * → 经 WS 回 approval-response。
   * 裁决 1（fail-closed）：用户回复 → allow + updatedInput.answers；5min 超时 → deny('审批超时')。
   * 两条路径都 clearTimeout + 删 pendingQuestions 条目。
   */
  private handleAskUserQuestion(toolUseId: string, questions: any[]): void {
    const targetChatId = this.responseChatId || this.defaultChatId;
    if (!targetChatId) {
      logger.warn(this.tag, `AskUserQuestion 无目标 chatId，fail-closed 回 deny (${toolUseId})`);
      this.sendApprovalResponse(toolUseId, { behavior: 'deny', message: '无目标会话' });
      return;
    }

    // 渲染选项卡片：问题 + 编号选项 + 回复方式提示
    const lines: string[] = ['🟡 请选择（回复编号或选项名）：'];
    for (const q of questions || []) {
      if (q?.question) lines.push(String(q.question));
      (q?.options || []).forEach((o: any, i: number) => {
        lines.push(`${i + 1}. ${o?.label}${o?.description ? ' - ' + o.description : ''}`);
      });
    }
    void this.patchCard('yellow', '🟡 请选择', lines.join('\n'));

    // 注册挂起审批，5min 超时 fail-closed deny（裁决 1：超时不 allow）
    const promise = new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingQuestions.has(toolUseId)) {
          this.pendingQuestions.delete(toolUseId);
          logger.warn(this.tag, `AskUserQuestion 审批超时，fail-closed deny (${toolUseId})`);
          resolve({ behavior: 'deny', message: '审批超时' });
        }
      }, 5 * 60 * 1000);
      this.pendingQuestions.set(toolUseId, { resolve, questions: questions || [], timer });
    });

    promise.then((outcome) => {
      this.sendApprovalResponse(toolUseId, outcome);
      if (outcome.behavior === 'allow') {
        const answers = (outcome as any).updatedInput?.answers || {};
        void this.patchCard('green', '🟢 已选择', Object.values(answers).join(', ') || '已确认');
      } else {
        void this.patchCard('red', '🔴 已拒绝', (outcome as any).message || '审批超时');
      }
    });
  }

  /** A2：经远程 WS 回 approval-response 给 hub（decision 为完整 PermissionResult） */
  private sendApprovalResponse(toolUseId: string, decision: PermissionResult): void {
    const ws = this.remoteWebWs;
    if (!ws || ws.readyState !== WS.OPEN) {
      logger.warn(this.tag, `远程 WS 不可用，approval-response 发送失败 (${toolUseId})`);
      return;
    }
    ws.send(JSON.stringify({
      type: 'approval-response',
      toolUseId,
      decision,
      botName: this.config.botName || 'ShrimpBot',
    }));
  }

  private dispatchToClaude(event: FeishuEvent, text: string): void {
    // SDK 模式：走 Claude Agent SDK，不经 PTY（feature flag 控制）
    if (this.sdkMode && this.sdkSession) {
      void this.dispatchToClaudeViaSDK(text, event.chatId);
      return;
    }
    // ===== 以下为旧 PTY 路径，SDK_EVENT_MODE 非 'true' 时完全不变 =====
    this.responseChatId = event.chatId;
    this.defaultChatId = event.chatId;
    this.lastUserMessage = text;
    this.completionHandled = false;
    this.permissionNotified = false;
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
        const targetChatId = this.responseChatId || this.defaultChatId;
        if (targetChatId) {
          const msg = '⏰ 响应超时（120秒），已自动解除阻塞。\n可能原因：Claude 进程卡住或回复过长。';
          if (this.config.clone) {
            this.enqueueSend(targetChatId, msg, false, '超时警告');
          } else {
            this.sendIndependentCard(targetChatId, 'yellow', '⏰ 响应超时', '已自动解除阻塞。可能原因：Claude 进程卡住或回复过长。');
          }
        }
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
    this.permissionNotified = false;
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

        // 权限确认 / 编号选项：流式阶段检测到就立即发飞书，不等 ❯
        if (!this.waitingForAnswer && !this.permissionNotified) {
          const isYesNoQ = this.isYesNoQuestion(this.streamBuffer);
          const hasOpts = this.containsNumberedOptions(this.streamBuffer);
          if (isYesNoQ || hasOpts) {
            this.permissionNotified = true;
            this.waitingForAnswer = true;
            if (isYesNoQ && !hasOpts && this.config.autoApprove !== false) {
              // yes/no 且非危险操作 → 自动通过
              const isDangerous = FeishuBridge.DANGEROUS_PATTERNS.some(p => p.test(this.streamBuffer));
              if (!isDangerous) {
                this.permissionNotified = false;
                this.waitingForAnswer = false;
                const approveMsg = `[自动通过] ${this.streamBuffer.slice(0, 200)}\n→ 已自动回复 yes`;
                if (this.config.clone) {
                  this.enqueueSend(targetChatId, approveMsg, true, '自动通过');
                } else {
                  this.patchCard('green', '🟢 自动通过', approveMsg);
                }
                setTimeout(() => { if (this.pty.isRunning()) this.pty.send('yes'); }, 500);
                return;
              }
              // 危险操作 → 发红色卡片等确认
              this.patchCard('red', '🔴 危险操作', `⚠️ 需要手动确认：\n${this.streamBuffer}`);
            } else if (isYesNoQ) {
              this.patchCard('yellow', '🟡 需要确认', this.streamBuffer);
            } else {
              const optionLines = this.streamBuffer.split('\n')
                .filter(l => /\d{1,2}[.)]\s+/.test(l.replace(/^\|\s*/, '').replace(/\s*\|$/, '')))
                .map(l => l.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim());
              if (optionLines.length >= 2) {
                this.patchCard('yellow', '🟡 请选择', `📋 请回复编号选择：\n${optionLines.join('\n')}`);
              }
            }
            if (!this.passthrough) {
              fs.writeSync(2, `\x1b[33m⏳ 等待飞书回复确认...\x1b[0m\n`);
            }
          }
        }
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
      // 非 clone 模式：检测是否是 yes/no 或编号选项，需要发飞书
      const isYesNoQ = this.isYesNoQuestion(fullText);
      const hasOptions = this.containsNumberedOptions(fullText);
      if (isYesNoQ || hasOptions) {
        // yes/no 或编号选项 → 直接发飞书卡片，等用户回复
        this.completionHandled = true;
        this.waitingForAnswer = true;
        if (isYesNoQ) {
          this.patchCard('yellow', '🟡 需要确认', fullText);
        } else {
          const optionLines = fullText.split('\n')
            .filter(l => /^\s*\d{1,2}[.)]\s+/.test(l) || /^\s*[(（]\d{1,2}[)）]\s+/.test(l))
            .map(l => l.trim());
          const message = `📋 请回复编号选择：\n${optionLines.join('\n')}`;
          this.patchCard('yellow', '🟡 请选择', message);
        }
        if (!this.passthrough) {
          fs.writeSync(2, `\x1b[33m⏳ 等待飞书回复确认...\x1b[0m\n`);
        }
        return;
      }
      // 普通 ❯：标记 PTY 就绪，等 Stop hook 带 transcript 完成卡片
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
    // 生成轮次 ID 防止旧轮次异步回写覆盖新轮次
    const roundId = Date.now();
    this._thinkingRoundId = roundId;
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
      // 仅当仍是当前轮次时才写入，避免旧 await 覆盖新卡片 ID
      if (this._thinkingRoundId === roundId) {
        this.currentCardId = resp.data?.message_id || null;
        logger.info(this.tag, `🔵 思考中卡片已发送: ${this.currentCardId}`);
      } else {
        logger.info(this.tag, `🔵 跳过旧轮次思考卡片: roundId=${roundId}, 当前=${this._thinkingRoundId}`);
      }
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
      const newCardId = resp.data?.message_id || null;
      logger.info(this.tag, `新卡片已发送: ${title} (${newCardId})`);
      // 如果是 keepAlive 模式（进度更新），保存新 messageId 以便后续继续 patch
      if (keepAlive && newCardId) {
        this.currentCardId = newCardId;
        this.currentCardChatId = chatId;
        return;
      }
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
      case 'PostToolUse': {
        const toolName = event.tool_name || 'unknown';
        // 只通知关键工具，减少噪音
        const importantTools = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
        if (importantTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()))) {
          const input = event.tool_input ? JSON.stringify(event.tool_input).slice(0, 200) : '';
          const content = input || `工具 ${toolName} 执行成功`;
          this.patchCard('blue', '🔄 处理中', `✅ ${toolName}: ${content}`, true);
        }
        break;
      }
      case 'SubagentStop': {
        const agentId = event.agent_id || '';
        const content = agentId ? `子代理 ${agentId.slice(0, 8)} 已完成` : '子代理已完成';
        this.patchCard('blue', '🔄 处理中', content, true);
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
    // 权限确认提示（Claude Code 新版格式）
    if (/needs?\s+your\s+permission/i.test(text)) return true;
    if (/allow\s+(this\s+)?tool/i.test(text)) return true;
    if (/bypass permissions/i.test(text)) return true;
    // 传统 yes/no 格式
    if (/\?\s*\[y\/n\]/i.test(text)) return true;
    if (/\(yes\/no\)/i.test(text)) return true;
    if (/\(y\/n\)/i.test(text)) return true;
    // 其他确认格式
    const PERM_PATTERNS = [/requires approval/i, /do you want/i, /proceed/i];
    if (PERM_PATTERNS.some(p => p.test(text))) {
      const hasYes = /\byes\b/i.test(text);
      const hasNo = /\bno\b/i.test(text);
      const hasAlways = /\balways\b/i.test(text) || /don'?t ask/i.test(text);
      return (hasYes && hasNo) || hasAlways;
    }
    return false;
  }

  private looksLikeQuestion(text: string): boolean {
    // 只认"明确选择指令"或问号结尾，避免解释性文本里的"选项/选择"词被误判为选择意图
    return /[？?]\s*$/m.test(text) || /请选择|请回复编号|选一个|选哪个|pick|choose|select/i.test(text);
  }

  private containsNumberedOptions(text: string): boolean {
    // 门控1：必须有"选择意图"，避免把 Claude 解释性的编号列表（如步骤 1. 2. 3.）误判为选项题
    // 仅当文本含问号或"选择/选一个/pick/choose/select"等词汇时才进一步检测编号
    if (!this.looksLikeQuestion(text)) return false;
    // 门控2：底部区域限定（选项总是出现在最近输出），避免历史编号行干扰
    const lines = text.split('\n').slice(-30);
    let count = 0;
    for (const line of lines) {
      // 匹配 "1. xxx" 或 "(1) xxx" 或 markdown 表格行 "| 1. xxx |"
      const cleaned = line.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim();
      if (/^\d{1,2}[.)]\s+/.test(cleaned) || /^[(（]\d{1,2}[)）]\s+/.test(cleaned)) count++;
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
  private connectToRemoteWebServer(hostOrPort: string | number): Promise<void> {
    return new Promise((resolve, reject) => {
      const botId = this.config.botName || 'ShrimpBot';
      let reconnectDelay = 1000;
      let settled = false;

      // 解析地址：字符串 "host:port" 或数字端口号（默认 127.0.0.1）
      const address = typeof hostOrPort === 'string'
        ? (hostOrPort.includes('://') ? hostOrPort : `ws://${hostOrPort}`)
        : `ws://127.0.0.1:${hostOrPort}`;
      const wsUrl = address.includes('/ws/bot') ? address : `${address}/ws/bot`;

      const connect = () => {
        const ws = new WS(wsUrl);

        ws.on('open', () => {
          // 标识自己
          ws.send(JSON.stringify({ type: 'bot-join', name: botId, cwd: this.config.claudeCwd || process.cwd() }));
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
            } else if (parsed.type === 'approval-request' && parsed.kind === 'question') {
              // A2：hub 转发的 AskUserQuestion 选项请求 → 飞书选项卡片 → 等用户回复 → 回 approval-response
              // hub 按契约发的是 botName 字段（定向发送，对齐 web-server.ts 的 approval-request 载荷）
              if (parsed.botName && parsed.botName !== botId) return;
              this.handleAskUserQuestion(parsed.toolUseId, parsed.questions || []);
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
    for (const p of this.pendingQuestions.values()) clearTimeout(p.timer);
    this.pendingQuestions.clear();
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
