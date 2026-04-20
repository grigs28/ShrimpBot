export const SERVER_CAPABILITIES = {
  capabilities: {
    experimental: {
      'claude/channel': {},
    },
    tools: {},
  },
};

// 可用工具列表
export const TOOLS = [
  {
    name: 'send_feishu_message',
    description: '发送消息到飞书',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '飞书会话 ID' },
        text: { type: 'string', description: '消息内容' },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'list_chats',
    description: '获取飞书会话列表',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_messages',
    description: '检查飞书缓冲区中的新消息并清空缓冲区',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
