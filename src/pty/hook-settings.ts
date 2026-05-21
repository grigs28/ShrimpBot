import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';

const HOOK_COMMAND_TEMPLATE = (host: string, botName?: string) => {
  const botParam = botName ? `?bot=${encodeURIComponent(botName)}` : '';
  const base = host.includes('://') ? host : `http://${host}`;
  return `curl -s -X POST ${base}/api/hook${botParam} -H 'Content-Type: application/json' -d @-`;
};

const HOOK_EVENTS = ['Stop', 'Notification', 'PostToolUseFailure', 'PostToolUse', 'SubagentStop'] as const;

/**
 * 从 .sbot 文件读取 FEISHU_BOT_NAME
 */
function readBotNameFromSbot(): string | undefined {
  const sbotPath = path.join(process.cwd(), '.sbot');
  if (!fs.existsSync(sbotPath)) return undefined;
  try {
    const content = fs.readFileSync(sbotPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim().startsWith('FEISHU_BOT_NAME=')) {
        return line.trim().slice('FEISHU_BOT_NAME='.length).trim() || undefined;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * 确保 .claude/settings.local.json 中包含 ShrimpBot 所需的 hook 配置
 * 保留现有配置（如 permissions），只合并/更新 hooks 部分
 * botName 优先级：参数 > 环境变量 > .sbot 文件
 */
export function ensureHookSettings(host: string, botName?: string): void {
  const claudeDir = path.join(process.cwd(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  // botName 优先级：参数 > 环境变量 > .sbot 文件
  const resolvedBotName = botName || process.env.FEISHU_BOT_NAME || readBotNameFromSbot();

  // 确保目录存在
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // 读取现有配置
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  const hookCommand = HOOK_COMMAND_TEMPLATE(host, resolvedBotName);
  const existingHooks = (settings.hooks || {}) as Record<string, unknown>;

  // 构建新的 hooks 配置
  const newHooks: Record<string, unknown> = { ...existingHooks };

  for (const eventName of HOOK_EVENTS) {
    const hookEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand }],
    };

    const existing = newHooks[eventName];
    if (Array.isArray(existing)) {
      // 替换已有的 shrimpbot hook（地址可能变了）
      const filtered = existing.filter(
        (e: any) => !(Array.isArray(e?.hooks) &&
          e.hooks.some((h: any) => h?.command?.includes('/api/hook'))),
      );
      newHooks[eventName] = [...filtered, hookEntry];
    } else {
      newHooks[eventName] = [hookEntry];
    }
  }

  settings.hooks = newHooks;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logger.info('HookSettings', `Hook 配置已写入 ${settingsPath} (host: ${host}, bot: ${resolvedBotName || 'local'})`);
}
