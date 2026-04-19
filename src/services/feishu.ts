import http from 'node:http';
import crypto from 'node:crypto';
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
    // 验证消息长度
    const MAX_MESSAGE_LENGTH = 5000;
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long: ${text.length} chars (max: ${MAX_MESSAGE_LENGTH})`);
    }

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
    if (!handler) {
      console.error(`No handler registered for chat_id: ${chatId}`);
      return;
    }

    const message: FeishuMessage = {
      chat_id: chatId,
      user_id: event.header?.sender?.sender_id?.user_id || '',
      user_name: event.header?.sender?.sender_id?.user_id || 'Unknown',
      text: event.event?.message?.content || '',
      timestamp: Date.now(),
    };

    handler(message);
  }

  // Webhook 事件处理
  startWebhook(port: number, verificationToken: string, encryptKey: string): void {
    // 验证加密密钥长度
    if (encryptKey && encryptKey.length < 32) {
      throw new Error('Encryption key must be at least 32 characters');
    }
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET') {
        // 飞书验证 URL
        const reqUrl = req.url || '/';
        const url = new URL(reqUrl, `http://localhost:${port}`);
        const challenge = url.searchParams.get('challenge');
        if (challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge);
          return;
        }
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            // 解析 JSON
            const event = JSON.parse(body);

            // 验证签名（如果提供了 encrypt_key）
            if (encryptKey && event.encrypt) {
              const decipher = crypto.createDecipheriv(
                'aes-256-cbc',
                Buffer.from(encryptKey.slice(0, 32)),
                Buffer.alloc(16, 0)
              );
              let decrypted = decipher.update(event.encrypt, 'base64', 'utf8');
              decrypted += decipher.final('utf8');
              Object.assign(event, JSON.parse(decrypted));
            }

            // 处理消息事件
            if (event.event?.message) {
              await this.handleFeishuEvent(event);
            }

            res.writeHead(200);
            res.end('ok');
          } catch (err) {
            console.error('Webhook 处理失败:', err);
            res.writeHead(500);
            res.end('error');
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(port, () => {
      console.error(`Webhook 服务器已启动，监听端口 ${port}`);
    });
  }

  // 获取飞书 SDK Client 实例
  getClient(): Client {
    return this.client;
  }
}
