import { describe, it, expect } from 'vitest';
import { SessionService } from '../src/services/session.js';

describe('SessionService', () => {
  it('getOrCreate 创建新会话', () => {
    const service = new SessionService();
    const session = service.getOrCreate('chat-123');
    expect(session.chatId).toBe('chat-123');
    expect(session.lastMessageTimestamp).toBe(0);
  });

  it('getOrCreate 返回已有会话', () => {
    const service = new SessionService();
    const s1 = service.getOrCreate('chat-123');
    const s2 = service.getOrCreate('chat-123');
    expect(s1).toBe(s2);
  });

  it('updateTimestamp 更新会话时间戳', () => {
    const service = new SessionService();
    service.getOrCreate('chat-123');
    service.updateTimestamp('chat-123', 999);
    const session = service.get('chat-123');
    expect(session?.lastMessageTimestamp).toBe(999);
  });

  it('delete 移除会话', () => {
    const service = new SessionService();
    service.getOrCreate('chat-123');
    service.delete('chat-123');
    expect(service.get('chat-123')).toBeUndefined();
  });

  it('list 返回所有会话', () => {
    const service = new SessionService();
    service.getOrCreate('chat-1');
    service.getOrCreate('chat-2');
    expect(service.list()).toHaveLength(2);
  });
});
