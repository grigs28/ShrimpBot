// SDK 桥内类型定义
// 将 Claude Agent SDK 的 SDKMessage 联合类型转换为桥内标准化事件

// SDK 事件 → 飞书端的标准化事件格式
export type SDKBridgeEvent =
  | { type: 'init'; sessionId: string; model: string; cwd: string }
  | { type: 'text'; text: string; partial: boolean }            // assistant 文本（partial=true 时流式）
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { type: 'approval_request'; request: ApprovalRequest }      // canUseTool 触发
  | { type: 'completed'; text: string; cost: number; turns: number; sessionId: string }
  | { type: 'error'; message: string; detail?: string };

export interface ApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  displayName?: string;   // 按钮标签
  title?: string;         // 预览提示语
  description?: string;   // 详细说明
  agentId?: string;       // 子代理 ID
  signal: AbortSignal;    // 审批超时可 abort
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };
