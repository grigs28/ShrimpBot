import { describe, it, expect } from 'vitest';
import { MCPServer } from '../src/server.js';

describe('Bot (MCPServer)', () => {
  describe('handlesChatId', () => {
    it('returns true for configured chatIds', () => {
      const server = new MCPServer({
        feishuAppId: 'test',
        feishuAppSecret: 'test',
        botName: 'test',
        chatIds: ['chat1', 'chat2'],
        webhookPort: 8080,
        debug: false,
      });
      expect(server.handlesChatId('chat1')).toBe(true);
      expect(server.handlesChatId('chat2')).toBe(true);
    });

    it('returns false for non-configured chatIds', () => {
      const server = new MCPServer({
        feishuAppId: 'test',
        feishuAppSecret: 'test',
        botName: 'test',
        chatIds: ['chat1', 'chat2'],
        webhookPort: 8080,
        debug: false,
      });
      expect(server.handlesChatId('chat3')).toBe(false);
    });

    it('returns true for all chatIds when empty', () => {
      const server = new MCPServer({
        feishuAppId: 'test',
        feishuAppSecret: 'test',
        botName: 'test',
        chatIds: [],
        webhookPort: 8080,
        debug: false,
      });
      expect(server.handlesChatId('any')).toBe(true);
      expect(server.handlesChatId('arbitrary')).toBe(true);
    });
  });

  describe('getChatIds', () => {
    it('returns configured chatIds', () => {
      const server = new MCPServer({
        feishuAppId: 'test',
        feishuAppSecret: 'test',
        botName: 'test',
        chatIds: ['chat1', 'chat2'],
        webhookPort: 8080,
        debug: false,
      });
      expect(server.getChatIds()).toEqual(['chat1', 'chat2']);
    });

    it('returns empty array when not configured', () => {
      const server = new MCPServer({
        feishuAppId: 'test',
        feishuAppSecret: 'test',
        botName: 'test',
        chatIds: [],
        webhookPort: 8080,
        debug: false,
      });
      expect(server.getChatIds()).toEqual([]);
    });
  });
});
