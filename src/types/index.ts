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

// 飞书实时事件
export interface FeishuEvent {
  chatId: string;
  chatType: 'p2p' | 'group';
  userId: string;
  messageId: string;
  text: string;
  messageType: string;
  timestamp: number;
}

// Claude Code Hook 事件
export interface HookEvent {
  hook_event_name: 'Stop' | 'Notification' | 'PostToolUseFailure' | 'PostToolUse' | 'PreToolUse';
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  // Stop
  reason?: string;
  stop_hook_reason?: string;
  stop_hook_active?: boolean;
  transcript_messages?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  // Notification
  message?: string;
  title?: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  error?: string;
}
