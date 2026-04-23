// src/pty/web-settings.ts — Web 设置存储（~/.shrimpbot/settings.json）

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';

const SETTINGS_DIR = path.join(os.homedir(), '.shrimpbot');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

export interface WebSettings {
  web_port?: number;
  admin_users?: string;
  log_level?: string;
  session_secret?: string;
  yz_login_url?: string;
  service_url?: string;
}

const DEFAULTS: WebSettings = {
  web_port: 5554,
  admin_users: 'grigs',
  log_level: 'info',
  session_secret: '',
  yz_login_url: 'http://192.168.0.18:5551',
  service_url: 'http://192.168.0.19:5554',
};

export function loadWebSettings(): WebSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return { ...DEFAULTS, ...data };
    }
  } catch (e) {
    logger.warn('WebSettings', `读取设置失败: ${(e as Error).message}`);
  }
  return { ...DEFAULTS };
}

export function saveWebSettings(settings: Partial<WebSettings>): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  const current = loadWebSettings();
  const merged = { ...current, ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  logger.info('WebSettings', '设置已保存');
}

export function getDefaultSettings(): WebSettings {
  return { ...DEFAULTS };
}
