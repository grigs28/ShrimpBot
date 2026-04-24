// src/pty/web-commands.ts — 每只虾的常用命令存储（~/.shrimpbot/commands/{botName}.json）

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';

const COMMANDS_DIR = path.join(os.homedir(), '.shrimpbot', 'commands');

export interface SavedCommand {
  /** 命令显示名称 */
  label: string;
  /** 实际执行的命令文本 */
  command: string;
}

function getCommandsPath(botName: string): string {
  return path.join(COMMANDS_DIR, `${botName}.json`);
}

export function loadCommands(botName: string): SavedCommand[] {
  try {
    const p = getCommandsPath(botName);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    logger.warn('WebCommands', `读取命令失败 [${botName}]: ${(e as Error).message}`);
  }
  return [];
}

export function saveCommands(botName: string, commands: SavedCommand[]): void {
  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  }
  fs.writeFileSync(getCommandsPath(botName), JSON.stringify(commands, null, 2));
  logger.info('WebCommands', `已保存 ${commands.length} 条命令 [${botName}]`);
}

/** 添加一条命令，返回新列表 */
export function addCommand(botName: string, label: string, command: string): SavedCommand[] {
  const cmds = loadCommands(botName);
  cmds.push({ label, command });
  saveCommands(botName, cmds);
  return cmds;
}

/** 删除一条命令，返回新列表 */
export function deleteCommand(botName: string, index: number): SavedCommand[] | null {
  const cmds = loadCommands(botName);
  if (index < 0 || index >= cmds.length) return null;
  cmds.splice(index, 1);
  saveCommands(botName, cmds);
  return cmds;
}
