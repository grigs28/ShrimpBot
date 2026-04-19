import type { FeishuService } from '../services/feishu.js';
import { TOOLS } from '../capabilities.js';

export class ToolsHandler {
  constructor(private feishuService: FeishuService) {}

  // 返回工具列表
  listTools() {
    return { tools: TOOLS };
  }

  // 处理工具调用
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'send_feishu_message':
        return this.sendMessage(args.chat_id, args.text);
      case 'list_chats':
        return this.listChats();
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
      const response = await this.feishuService.getClient().im.v1.chat.get();
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
}
