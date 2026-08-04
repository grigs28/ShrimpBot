import type { SDKBridgeEvent } from './sdk-types.js';

/** 卡片渲染输出：FeishuBridge 据此调 patchCard / sendCard */
export interface CardState {
  color: 'blue' | 'green' | 'yellow' | 'red';
  header: string;
  content: string;
  /** 是否终态卡片（完成后不可再 patch） */
  isTerminal: boolean;
}

/** 渲染器的累积状态（across events in one turn） */
interface RenderState {
  textParts: string[];
  toolCount: number;
  lastToolName: string;
  hasError: boolean;
  errorMessage: string;
}

/**
 * 从单次 turn 的 SDK 事件流生成飞书卡片。
 * 多次调用 addEvent(event) 累积状态，finalize() 产出终态卡片。
 */
export class FeishuCardRenderer {
  private state: RenderState = { textParts: [], toolCount: 0, lastToolName: '', hasError: false, errorMessage: '' };

  /** 添加一个事件，返回是否需要发中间态 patch（true=发） */
  addEvent(event: SDKBridgeEvent): boolean {
    switch (event.type) {
      case 'text':
        this.state.textParts.push(event.text);
        return true; // 流式文本，发 patch
      case 'tool_use':
        this.state.toolCount++;
        this.state.lastToolName = event.toolName;
        return true; // 工具调用，发"执行中"patch
      case 'tool_result':
        return false; // 工具结果不发独立卡片，等文本或完成
      case 'error':
        this.state.hasError = true;
        this.state.errorMessage = event.message;
        return true;
      default:
        return false;
    }
  }

  /** 产出终态卡片状态 */
  finalize(): CardState {
    if (this.state.hasError) {
      return { color: 'red', header: '🔴 错误', content: this.state.errorMessage || '未知错误', isTerminal: true };
    }
    const text = this.state.textParts.join('\n');
    if (!text && this.state.toolCount > 0) {
      return { color: 'blue', header: '🛠 执行中', content: `执行 ${this.state.lastToolName}...`, isTerminal: false };
    }
    return { color: 'green', header: '🟢 完成', content: text, isTerminal: true };
  }

  /** 中间态卡片（流式/工具过程中） */
  getIntermediate(): CardState {
    const text = this.state.textParts.join('\n');
    if (this.state.hasError) {
      return { color: 'red', header: '🔴 错误', content: this.state.errorMessage, isTerminal: true };
    }
    if (text) {
      return { color: 'blue', header: '🔵 思考中', content: text.slice(-2000), isTerminal: false };
    }
    if (this.state.toolCount > 0) {
      return { color: 'blue', header: '🔄 处理中', content: `执行工具: ${this.state.lastToolName}`, isTerminal: false };
    }
    return { color: 'blue', header: '🔵 思考中', content: '', isTerminal: false };
  }

  /** 重置为新一轮 */
  reset(): void {
    this.state = { textParts: [], toolCount: 0, lastToolName: '', hasError: false, errorMessage: '' };
  }
}
