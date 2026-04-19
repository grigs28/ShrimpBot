// 飞书消息来源
export interface FeishuMessage {
  chat_id: string;
  user_id: string;
  user_name: string;
  text: string;
  timestamp: number;
}

// Claude Channel 消息格式
export interface ClaudeChannelMessage {
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
}

// 会话状态
export interface Session {
  chatId: string;
  lastMessageTimestamp: number;
  createdAt: number;
}

// 配置
export interface Config {
  feishuAppId: string;
  feishuAppSecret: string;
  botName: string;
  chatIds: string[];
  webhookPort: number;
  debug: boolean;
}

export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  chatIds: string[];
}

export interface MultiBotConfig {
  bots: BotConfig[];
}
