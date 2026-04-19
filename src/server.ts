import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeishuService } from './services/feishu.js';
import { SessionService } from './services/session.js';
import { ChannelHandler } from './handlers/channel.js';
import { ToolsHandler } from './handlers/tools.js';
import { SERVER_CAPABILITIES } from './capabilities.js';
import type { Config } from './types/index.js';

export class MCPServer {
  private server: Server;
  private feishuService: FeishuService;
  private sessionService: SessionService;
  private channelHandler: ChannelHandler;
  private toolsHandler: ToolsHandler;
  private chatIds: string[];
  private botName: string;

  constructor(private config: Config) {
    this.feishuService = new FeishuService(config.feishuAppId, config.feishuAppSecret);
    this.sessionService = new SessionService();
    this.channelHandler = new ChannelHandler(this.feishuService, this.sessionService);
    this.toolsHandler = new ToolsHandler(this.feishuService);
    this.chatIds = config.chatIds || [];
    this.botName = config.botName || 'ShrimpBot';

    this.server = new Server(
      { name: `claude-code-channels-feishu-${this.botName}`, version: '1.0.0' },
      SERVER_CAPABILITIES
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // 注意: Claude Channel 通知 (notifications/claude/channel) 是实验性 API
    // 当前 MCP SDK 不支持，如需使用请参考 Claude Code Channels 协议文档

    // 处理工具列表
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => this.toolsHandler.listTools()
    );

    // 处理工具调用
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (params: any) => {
        // MCP SDK wraps in { method, params } - extract name and arguments
        const name = params?.params?.name;
        const args = params?.params?.arguments;
        if (!name || typeof name !== 'string') {
          throw new Error('Invalid tool name');
        }
        const result = await this.toolsHandler.callTool(name, args || {});
        return { content: [{ type: 'text', text: result }] };
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${this.botName} (chatIds: ${this.chatIds.join(', ') || 'all'}) 已启动`);
  }

  // 获取该 Bot 负责的 chatIds
  getChatIds(): string[] {
    return this.chatIds;
  }

  // 检查是否处理该 chat_id
  handlesChatId(chatId: string): boolean {
    if (this.chatIds.length === 0) return true; // 无配置则处理所有
    return this.chatIds.includes(chatId);
  }

  // 处理收到的飞书消息（供 Master 调用）
  async handleIncomingMessage(msg: { chat_id: string; content: string }): Promise<void> {
    if (!this.handlesChatId(msg.chat_id)) {
      console.error(`Bot ${this.botName} does not handle chat_id: ${msg.chat_id}`);
      return;
    }
    // 转发给 channelHandler 处理
    await this.channelHandler.handleNotification({
      message: {
        content: msg.content,
        timestamp: Date.now(),
      },
      session_id: msg.chat_id,
    });
  }
}
