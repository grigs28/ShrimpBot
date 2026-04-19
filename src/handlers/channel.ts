import type { FeishuService } from '../services/feishu.js';
import type { SessionService } from '../services/session.js';
import type { ClaudeChannelMessage } from '../types/index.js';

export class ChannelHandler {
  constructor(
    private feishuService: FeishuService,
    private sessionService: SessionService
  ) {}

  // 处理 Claude Channel 通知
  async handleNotification(params: any): Promise<void> {
    const message = params.message as ClaudeChannelMessage;
    if (!message?.content) return;

    // 从通知中提取 chat_id（Claude Code 会话关联的飞书会话）
    const chatId = this.extractChatId(params);
    if (!chatId) return;

    // 更新会话时间戳
    this.sessionService.updateTimestamp(chatId, message.timestamp);

    // 发送到飞书
    try {
      await this.feishuService.sendMessage(chatId, message.content);
    } catch (err) {
      console.error('发送飞书消息失败:', err);
    }
  }

  // 从通知参数中提取 chat_id
  private extractChatId(params: any): string | undefined {
    // Claude Channel 协议可能通过 session_id 或其他字段关联会话
    return params.session_id || params.chat_id;
  }
}
