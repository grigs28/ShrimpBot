/**
 * ReadyGate：PTY 就绪门闸（启动一次性闩锁）。
 *
 * 用途：bot 刚启动、`claude -c` 还在恢复会话时，TUI 尚未就绪，
 * 此时写入的 `\r` 会被初始化流程吞掉 → 消息停在输入框里需人工回车。
 * 投递前先 await waitReady()，等 ❯ 出现后再写。
 *
 * **就绪是单调事实**：TUI 初始化完成过一次就永远算就绪，没有"重新变忙"的转换。
 * 因为 ❯ 只在解析到新的 PTY 输出时才触发——claude 空闲时静静地停在提示符上、
 * 不产出输出，若把"就绪"按每轮消息重置，就再也没有事件能恢复它，
 * 门闸会一直等到超时（实机踩过：每条消息白等 30 秒）。
 * PTY 崩溃时整个进程退出重来，新进程天然是新的门闸，无需在进程内重置。
 *
 * 契约：**永不挂住调用方**——超时 fail-open 返回 false，调用方照常投递。
 */
interface Waiter {
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReadyGate {
  private ready = false;
  private waiters: Waiter[] = [];

  /** TUI 出现就绪提示（❯）时调用。单调：一旦就绪便不再变回未就绪 */
  markReady(): void {
    this.ready = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }

  /** 等待就绪；已就绪立即返回 true，超时返回 false（fail-open） */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          // 超时：自我摘除后 fail-open
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

/**
 * 等就绪后投递；超时 fail-open 仍投递（绝不挂住消息）。
 * 返回值表示是否真的等到了就绪，仅供调用方决定要不要打告警日志。
 */
export async function deliverWhenReady(
  gate: ReadyGate,
  deliver: () => void,
  timeoutMs: number,
): Promise<boolean> {
  const ready = await gate.waitReady(timeoutMs);
  deliver();
  return ready;
}
