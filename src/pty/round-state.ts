/**
 * RoundState：轮次识别。
 *
 * 用途：cron 计划任务等**不经输入路径**发起的轮次，没有人调用 beginRound() 复位
 * 轮次状态，导致其 Stop 定稿 / Notification / 流式累积全被旧轮次的标志挡住、
 * 输出在飞书上不可见（实机定性：cron 轮只有紧跟用户交互后的第一轮可见）。
 *
 * Claude Code 的 hook 载荷携带 prompt_id 且**逐轮变化**（transcript 中每轮一个
 * 新 UUID；hub /api/hook 原样转发，远端 bot 拿得到）。用它从输出侧识别"没人
 * 发起过的新轮次"。
 *
 * `roundActive` 由调用方传入（即 FeishuBridge 的 claudeBusy）——单一事实源，
 * 本类不持有轮次进行中状态，只持有当前轮次的 prompt_id。
 */
export type RoundVerdict = 'new-external' | 'same' | 'recorded';

export class RoundState {
  private currentPromptId: string | null = null;

  /**
   * 观察 hook 事件携带的 prompt_id。
   *
   * | 条件 | 返回 |
   * |---|---|
   * | 无 prompt_id（旧 CLI 降级） | 'same'（行为退回现状，不会更坏） |
   * | 轮次进行中 | 记录 id，'recorded'（不触发，防用户轮误判） |
   * | 无轮次 + id 与当前相同（迟到的同轮 hook） | 'same'（防轮末回放误触发） |
   * | 无轮次 + id 不同（cron 等外部发起） | 记录 id，'new-external' |
   */
  observeHookPromptId(promptId: string | undefined, roundActive: boolean): RoundVerdict {
    if (!promptId) return 'same';
    if (roundActive) {
      this.currentPromptId = promptId;
      return 'recorded';
    }
    if (promptId === this.currentPromptId) return 'same';
    this.currentPromptId = promptId;
    return 'new-external';
  }
}
