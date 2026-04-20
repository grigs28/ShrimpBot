import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeishuService } from './services/feishu.js';
import { SessionService } from './services/session.js';
import { ChannelHandler } from './handlers/channel.js';
import { ToolsHandler } from './handlers/tools.js';
import type { Config, FeishuEvent } from './types/index.js';

export class MCPServer {
  private server: Server;
  private feishuService: FeishuService;
  private sessionService: SessionService;
  private channelHandler: ChannelHandler;
  private toolsHandler: ToolsHandler;
  private chatIds: string[];
  private botName: string;
  private allowedUsers: string[];
  private messageBuffer: FeishuEvent[] = [];
  private readonly MAX_BUFFER_SIZE = 100;

  constructor(private config: Config) {
    this.feishuService = new FeishuService(config.feishuAppId, config.feishuAppSecret);
    this.sessionService = new SessionService();
    this.channelHandler = new ChannelHandler(this.feishuService, this.sessionService);
    this.toolsHandler = new ToolsHandler(this.feishuService, this);
    this.chatIds = config.chatIds || [];
    this.botName = config.botName || 'ShrimpBot';
    this.allowedUsers = (process.env.FEISHU_ALLOWED_USERS || '').split(',').filter(Boolean);

    this.server = new Server(
      { name: `feishu`, version: '1.0.0' },
      {
        capabilities: {
          experimental: { 'claude/channel': {} },
          tools: {},
        },
        instructions: `Messages from Feishu arrive as <channel source="feishu" ...>. This is a two-way chat channel. When a user sends a message, read it and respond. Use the "send_feishu_message" tool with the chat_id from the meta to reply. Use "check_messages" to poll for any buffered messages.`,
      },
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => this.toolsHandler.listTools()
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (params: any) => {
        const name = params?.params?.name;
        const args = params?.params?.arguments;
        if (!name || typeof name !== 'string') {
          throw new Error('Invalid tool name');
        }
        const result = await this.toolsHandler.callTool(name, args || {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${this.botName} (chatIds: ${this.chatIds.join(', ') || 'all'}) 已启动`);

    // 启动 WSClient 接收实时飞书消息
    this.feishuService.startWSClient((event) => this.handleFeishuEvent(event));
  }

  // 处理收到的飞书实时消息
  private async handleFeishuEvent(event: FeishuEvent): Promise<void> {
    if (this.chatIds.length > 0 && !this.chatIds.includes(event.chatId)) {
      return;
    }

    if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(event.userId)) {
      console.error(`Ignoring message from unauthorized user: ${event.userId}`);
      return;
    }

    // 缓冲消息
    this.messageBuffer.push(event);
    if (this.messageBuffer.length > this.MAX_BUFFER_SIZE) {
      this.messageBuffer.shift();
    }

    // 通过 MCP Channel Notification 推送到 Claude Code
    await this.pushToClaudeCode(event);
  }

  // 按照官方 Channels 规范推送通知
  private async pushToClaudeCode(event: FeishuEvent): Promise<void> {
    const notification = {
      method: 'notifications/claude/channel',
      params: {
        content: event.text,
        meta: {
          chat_id: event.chatId,
          user_id: event.userId,
          message_id: event.messageId,
          chat_type: event.chatType,
          ts: new Date(event.timestamp).toISOString(),
        },
      },
    };
    const fs = await import('fs');
    const log = (msg: string) => {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync('/tmp/shrimpbot-debug.log', line);
    };
    log(`Sending notification: ${JSON.stringify(notification)}`);
    try {
      await this.server.notification(notification);
      log(`Notification sent OK: ${event.text}`);
    } catch (err: any) {
      log(`Notification FAILED: ${err?.message || err}`);
    }
  }

  drainMessages(): FeishuEvent[] {
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    return messages;
  }

  getChatIds(): string[] {
    return this.chatIds;
  }

  handlesChatId(chatId: string): boolean {
    if (this.chatIds.length === 0) return true;
    return this.chatIds.includes(chatId);
  }

  async handleIncomingMessage(msg: { chat_id: string; content: string }): Promise<void> {
    if (!this.handlesChatId(msg.chat_id)) {
      console.error(`Bot ${this.botName} does not handle chat_id: ${msg.chat_id}`);
      return;
    }
    await this.channelHandler.handleNotification({
      message: { content: msg.content, timestamp: Date.now() },
      session_id: msg.chat_id,
    });
  }
}
