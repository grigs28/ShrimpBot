import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

  constructor(config: Config) {
    this.feishuService = new FeishuService(config.feishuAppId, config.feishuAppSecret);
    this.sessionService = new SessionService();
    this.channelHandler = new ChannelHandler(this.feishuService, this.sessionService);
    this.toolsHandler = new ToolsHandler(this.feishuService);

    this.server = new Server(
      { name: 'claude-code-channels-feishu', version: '1.0.0' },
      SERVER_CAPABILITIES
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // 处理 Claude Channel 通知
    this.server.setRequestHandler(
      { method: 'notifications/claude/channel' } as any,
      async (params: any) => {
        await this.channelHandler.handleNotification(params);
        return { status: 'ok' };
      }
    );

    // 处理工具列表
    this.server.setRequestHandler(
      { method: 'tools/list' },
      async () => this.toolsHandler.listTools()
    );

    // 处理工具调用
    this.server.setRequestHandler(
      { method: 'tools/call' },
      async (params: any) => {
        const result = await this.toolsHandler.callTool(params.name, params.arguments);
        return { content: [{ type: 'text', text: result }] };
      }
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Claude Code Channels Feishu Bridge 已启动');
  }
}
