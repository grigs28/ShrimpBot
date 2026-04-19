import { Client } from '@larksuiteoapi/node-sdk';
import type { FeishuMessage } from '../types/index.js';

export class FeishuService {
  private client: Client;
  private messageHandlers: Map<string, (msg: FeishuMessage) => void> = new Map();

  constructor(appId: string, appSecret: string) {
    this.client = new Client({
      appId,
      appSecret,
      disableTokenCache: false,
    });
  }

  // 发送消息到飞书
  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      params: {
        receive_id_type: 'chat_id',
      },
    });
  }

  // 注册消息处理器
  onMessage(chatId: string, handler: (msg: FeishuMessage) => void): void {
    this.messageHandlers.set(chatId, handler);
  }

  // 处理接收到的飞书消息
  async handleFeishuEvent(event: any): Promise<void> {
    const chatId = event.header?.chat_id || '';
    const handler = this.messageHandlers.get(chatId);
    if (!handler) return;

    const message: FeishuMessage = {
      chat_id: chatId,
      user_id: event.header?.sender?.sender_id?.user_id || '',
      user_name: event.header?.sender?.sender_id?.user_id || 'Unknown',
      text: event.event?.message?.content || '',
      timestamp: Date.now(),
    };

    handler(message);
  }

  // 启动 Webhook 监听（占位，后续实现）
  startWebhook(port: number): void {
    // TODO: 实现 Webhook 服务器
  }
}
