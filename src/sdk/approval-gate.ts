/**
 * 等效 bypass：只 AskUserQuestion 转发飞书选项，其他工具全 allow（不审批）。
 * 行为等价 --dangerously-skip-permissions，但保留 AskUserQuestion 的 PermissionRequest hook。
 */
export function classify(toolName: string, _input: Record<string, unknown>): 'allow' | 'question' {
  if (toolName === 'AskUserQuestion') return 'question';
  return 'allow';
}
