import { describe, it, expect } from 'vitest';
import { ReadyGate, deliverWhenReady } from '../readiness-gate.js';

describe('ReadyGate', () => {
  it('已就绪时 waitReady 立即返回 true', async () => {
    const gate = new ReadyGate();
    gate.markReady();
    await expect(gate.waitReady(1000)).resolves.toBe(true);
  });

  it('等待期间 markReady → 解析为 true', async () => {
    const gate = new ReadyGate();
    const waiting = gate.waitReady(1000);
    gate.markReady();
    await expect(waiting).resolves.toBe(true);
  });

  it('超时未就绪 → fail-open 返回 false（不挂住调用方）', async () => {
    const gate = new ReadyGate();
    await expect(gate.waitReady(20)).resolves.toBe(false);
  });

  it('就绪是单调事实：markReady 后反复等待都立即返回（不会被重置）', async () => {
    const gate = new ReadyGate();
    gate.markReady();
    await expect(gate.waitReady(20)).resolves.toBe(true);
    await expect(gate.waitReady(20)).resolves.toBe(true);
  });

  it('并发等待：markReady 后每个等待者都得到 true（后者不吞掉前者）', async () => {
    const gate = new ReadyGate();
    const first = gate.waitReady(200);
    const second = gate.waitReady(200);
    gate.markReady();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});

describe('deliverWhenReady（等就绪再投递，超时 fail-open）', () => {
  it('未就绪时不投递；markReady 后才投递', async () => {
    const gate = new ReadyGate();
    const delivered: string[] = [];

    const pending = deliverWhenReady(gate, () => delivered.push('投递'), 1000);

    expect(delivered).toEqual([]);   // 关键：就绪前绝不写 PTY

    gate.markReady();
    await expect(pending).resolves.toBe(true);
    expect(delivered).toEqual(['投递']);
  });

  it('已就绪时立即投递', async () => {
    const gate = new ReadyGate();
    gate.markReady();
    const delivered: string[] = [];

    await expect(deliverWhenReady(gate, () => delivered.push('投递'), 1000)).resolves.toBe(true);
    expect(delivered).toEqual(['投递']);
  });

  it('超时 fail-open：仍投递，返回 false（绝不挂住消息）', async () => {
    const gate = new ReadyGate();
    const delivered: string[] = [];

    await expect(deliverWhenReady(gate, () => delivered.push('投递'), 20)).resolves.toBe(false);
    expect(delivered).toEqual(['投递']);
  });
});
