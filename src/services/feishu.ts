import http from 'node:http';
import crypto from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuMessage, FeishuEvent } from '../types/index.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB 请求体限制

export class FeishuService {
  private client: lark.Client;
  private messageHandlers: Map<string, (msg: FeishuMessage) => void> = new Map();
  private webhookServer: http.Server | null = null;
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.client = new lark.Client({
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
    this.webhookServer = http.createServer(async (req, res) => {
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
        let bodySize = 0;
        req.on('data', chunk => {
          bodySize += chunk.length;
          if (bodySize > MAX_BODY_SIZE) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request body too large' }));
            req.destroy();
            return;
          }
          body += chunk;
        });
        req.on('error', (err) => {
          console.error('Request error:', err.message);
        });
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
              // 安全合并：避免 Object.assign 原型污染
              const decryptedData = JSON.parse(decrypted) as Record<string, unknown>;
              for (const key of Object.keys(decryptedData)) {
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
                (event as any)[key] = decryptedData[key];
              }
            }

            // 处理消息事件
            if (event.event?.message) {
              await this.handleFeishuEvent(event);
            }

            res.writeHead(200);
            res.end('ok');
          } catch (err) {
            console.error('Webhook 处理失败:', err);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end('error');
            }
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.webhookServer.listen(port, () => {
      console.error(`Webhook 服务器已启动，监听端口 ${port}`);
    });
  }

  // 停止 Webhook 服务器
  stopWebhook(): void {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }

  // 通过 WebSocket 长连接接收实时消息
  startWSClient(onMessage: (event: FeishuEvent) => void): void {
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
          onMessage(event);
        } catch (err) {
          console.error('WSClient message parse error:', err);
        }
      },
    });

    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    });

    wsClient.start({ eventDispatcher: dispatcher });
    console.error('WSClient WebSocket 连接已启动');
  }

  // 解析飞书消息内容
  private parseMessageContent(messageType: string, content: string): string {
    if (!content) return '';
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      }
      // 富文本等其他类型提取纯文本
      return parsed.text || content;
    } catch {
      return content;
    }
  }

  // 获取飞书 SDK Client 实例
  getClient(): lark.Client {
    return this.client;
  }
}
