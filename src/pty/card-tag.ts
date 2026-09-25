/**
 * cardTagPrefix：飞书卡片标题的目录名前缀。
 *
 * 多咪并行时卡片缺项目上下文（头像只标识"哪只咪"，不标识"哪个项目"），
 * 标题加 [目录名] 前缀以便溯源。取法与 Web 端 getBotList() 的 tab 标签
 * （"Log咪 (loging)"）同款——工作目录（CLAUDE_CWD）末段；取不到则为空串、
 * 标题保持原样。
 */
export function cardTagPrefix(claudeCwd?: string): string {
  const seg = (claudeCwd || '').split('/').filter(Boolean).pop();
  return seg ? `[${seg}] ` : '';
}
