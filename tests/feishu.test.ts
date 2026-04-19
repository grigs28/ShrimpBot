import { describe, it, expect, vi } from 'vitest';
import { FeishuService } from '../src/services/feishu.js';

const mockCreate = vi.fn().mockResolvedValue({});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        message: { create: mockCreate },
      },
    },
  })),
}));

describe('FeishuService', () => {
  it('sendMessage 调用 IM API', async () => {
    const service = new FeishuService('app-id', 'app-secret');
    await service.sendMessage('chat-123', 'Hello');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receive_id: 'chat-123',
          msg_type: 'text',
        }),
      })
    );
  });
});
