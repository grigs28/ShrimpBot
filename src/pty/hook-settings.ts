import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';

const HOOK_COMMAND_TEMPLATE = (port: number) =>
  `curl -s -X POST http://localhost:${port}/api/hook -H 'Content-Type: application/json' -d @-`;

const HOOK_EVENTS = ['Stop', 'Notification', 'PostToolUseFailure'] as const;

/**
 * 确保 .claude/settings.local.json 中包含 ShrimpBot 所需的 hook 配置
 * 保留现有配置（如 permissions），只合并/更新 hooks 部分
 */
export function ensureHookSettings(port: number): void {
  const claudeDir = path.join(process.cwd(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

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

  const hookCommand = HOOK_COMMAND_TEMPLATE(port);
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
      // 检查是否已有相同命令
      const hasShrimpBot = existing.some(
        (e: any) => Array.isArray(e?.hooks) &&
          e.hooks.some((h: any) => h?.command?.includes('/api/hook')),
      );
      if (!hasShrimpBot) {
        newHooks[eventName] = [...existing, hookEntry];
      }
    } else {
      newHooks[eventName] = [hookEntry];
    }
  }

  settings.hooks = newHooks;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logger.info('HookSettings', `Hook 配置已写入 ${settingsPath} (端口: ${port})`);
}
