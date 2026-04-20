import type { FeishuService } from '../services/feishu.js';
import type { MCPServer } from '../server.js';
import { TOOLS } from '../capabilities.js';

export class ToolsHandler {
  constructor(
    private feishuService: FeishuService,
    private mcpServer: MCPServer,
  ) {}

  // 返回工具列表
  listTools() {
    return { tools: TOOLS };
  }

  // 处理工具调用
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    // 防止原型污染攻击
    const dangerous = ['__proto__', 'constructor', 'prototype'];
    for (const key of Object.keys(args)) {
      if (dangerous.includes(key)) {
        throw new Error(`Invalid argument key: ${key}`);
      }
    }

    switch (name) {
      case 'send_feishu_message':
        return this.sendMessage(args.chat_id, args.text);
      case 'list_chats':
        return this.listChats();
      case 'check_messages':
        return this.checkMessages();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async sendMessage(chatId: string, text: string): Promise<string> {
    await this.feishuService.sendMessage(chatId, text);
    return `消息已发送到 ${chatId}`;
  }

  private async listChats(): Promise<any> {
    try {
      const response = await this.feishuService.getClient().im.v1.chat.get() as any;
      const chats = response.data?.items || [];
      return {
        chats: chats.map((chat: any) => ({
          chat_id: chat.chat_id,
          name: chat.name,
          description: chat.description,
        }))
      };
    } catch (err) {
      console.error('获取会话列表失败:', err);
      return { chats: [] };
    }
  }

  private checkMessages(): any {
    const messages = this.mcpServer.drainMessages();
    return {
      count: messages.length,
      messages: messages.map(m => ({
        chat_id: m.chatId,
        user_id: m.userId,
        message_id: m.messageId,
        text: m.text,
        type: m.messageType,
        timestamp: m.timestamp,
      })),
    };
  }
}
