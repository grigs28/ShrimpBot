import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Master } from '../src/master.js';
import type { MultiBotConfig } from '../src/types/index.js';

describe('Master', () => {
  let master: Master;

  afterEach(() => {
    if (master) {
      master.stop();
    }
  });

  describe('routeByChatId', () => {
    it('routes chat_id to correct bot', () => {
      const config: MultiBotConfig = {
        bots: [
          { name: 'bot1', appId: 'a', appSecret: 'b', chatIds: ['chat1', 'chat2'] },
          { name: 'bot2', appId: 'c', appSecret: 'd', chatIds: ['chat3'] },
        ],
      };
      master = new Master(config);
      expect(master.routeByChatId('chat1')).toBe('bot1');
      expect(master.routeByChatId('chat2')).toBe('bot1');
      expect(master.routeByChatId('chat3')).toBe('bot2');
    });

    it('returns undefined for unknown chat_id', () => {
      const config: MultiBotConfig = {
        bots: [
          { name: 'bot1', appId: 'a', appSecret: 'b', chatIds: ['chat1'] },
        ],
      };
      master = new Master(config);
      expect(master.routeByChatId('unknown')).toBeUndefined();
    });

    it('handles empty chatIds', () => {
      const config: MultiBotConfig = {
        bots: [
          { name: 'bot1', appId: 'a', appSecret: 'b', chatIds: [] },
        ],
      };
      master = new Master(config);
      expect(master.routeByChatId('any_chat')).toBeUndefined();
    });
  });

  describe('stop', () => {
    it('cleans up without errors', () => {
      const config: MultiBotConfig = {
        bots: [
          { name: 'bot1', appId: 'a', appSecret: 'b', chatIds: ['chat1'] },
        ],
      };
      master = new Master(config);
      expect(() => master.stop()).not.toThrow();
    });
  });
});
