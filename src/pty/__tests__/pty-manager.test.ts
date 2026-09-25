import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PTYManager } from '../pty-manager.js';

/** 记录写入字节的假 PTY（替代 node-pty，避免 spawn 真实 claude） */
const state: { writes: string[] } = { writes: [] };
let fakePty: Record<string, unknown>;

vi.mock('node-pty', () => ({
  spawn: () => fakePty,
}));

function startManager(): PTYManager {
  state.writes = [];
  fakePty = {
    pid: 4242,
    onData: () => {},
    onExit: () => {},
    write: (data: string) => { state.writes.push(data); },
    resize: () => {},
    kill: () => {},
  };
  const manager = new PTYManager({ botName: 'test', autoRestart: false });
  manager.start();
  return manager;
}

describe('PTYManager.send 投递语义', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('单行：一次写入 text + \\r（保持原行为）', () => {
    const manager = startManager();
    manager.send('检查备份情况');
    expect(state.writes).toEqual(['检查备份情况\r']);
  });

  it('多行：先写文本（不含 \\r），延迟后单独写 \\r', async () => {
    const manager = startManager();
    manager.send('=====\nPVE 超融合网络配置\n要显示版本');

    // 文本立即写入，且不带 \r —— 否则会被 TUI 当作粘贴内容吞掉
    expect(state.writes).toEqual(['=====\nPVE 超融合网络配置\n要显示版本']);

    await vi.advanceTimersByTimeAsync(200);

    // 回车作为独立一次写入，等价于用户手按 Enter
    expect(state.writes).toEqual(['=====\nPVE 超融合网络配置\n要显示版本', '\r']);
  });

  it('延迟窗口内 PTY 已停：不写入 \\r', async () => {
    const manager = startManager();
    manager.send('a\nb');
    manager.stop();

    await vi.advanceTimersByTimeAsync(200);

    expect(state.writes).toEqual(['a\nb']);
  });
});
