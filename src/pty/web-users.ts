// src/pty/web-users.ts — 本地用户管理（~/.shrimpbot/users.json）

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';

const SHRIMPBOT_DIR = path.join(os.homedir(), '.shrimpbot');
const USERS_PATH = path.join(SHRIMPBOT_DIR, 'users.json');

export interface LocalUser {
  id: number;
  username: string;
  display_name: string;
  /** admin | user */
  role: 'admin' | 'user';
}

/** 超级管理员，不可降级 */
const SUPER_ADMIN = 'grigs';

export function loadUsers(): LocalUser[] {
  try {
    if (fs.existsSync(USERS_PATH)) {
      return JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
    }
  } catch (e) {
    logger.warn('WebUsers', `读取用户列表失败: ${(e as Error).message}`);
  }
  return [];
}

export function saveUsers(users: LocalUser[]): void {
  if (!fs.existsSync(SHRIMPBOT_DIR)) {
    fs.mkdirSync(SHRIMPBOT_DIR, { recursive: true });
  }
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

/**
 * 登录时调用：记录或更新用户，返回该用户的角色
 * - 新用户默认 role=user
 * - grigs 始终为 admin
 * - SSO 的 is_admin 被完全忽略
 */
export function upsertUser(ssoUser: { id: number; username: string; display_name: string }): LocalUser {
  const users = loadUsers();
  let user = users.find(u => u.id === ssoUser.id);

  if (user) {
    // 更新显示名
    user.display_name = ssoUser.display_name || ssoUser.username;
    // grigs 始终为 admin
    if (user.username === SUPER_ADMIN) {
      user.role = 'admin';
    }
  } else {
    // 新用户，默认 user
    user = {
      id: ssoUser.id,
      username: ssoUser.username,
      display_name: ssoUser.display_name || ssoUser.username,
      role: ssoUser.username === SUPER_ADMIN ? 'admin' : 'user',
    };
    users.push(user);
  }

  saveUsers(users);
  return user;
}

/** 查询用户角色，不存在返回 null */
export function getUserRole(userId: number): 'admin' | 'user' | null {
  const users = loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return null;
  // grigs 始终为 admin
  if (user.username === SUPER_ADMIN) return 'admin';
  return user.role;
}

/** 设置用户角色，grigs 不可降级 */
export function setUserRole(userId: number, role: 'admin' | 'user'): boolean {
  const users = loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return false;
  if (user.username === SUPER_ADMIN && role !== 'admin') return false; // 不可降级
  user.role = role;
  saveUsers(users);
  logger.info('WebUsers', `用户 ${user.username} 角色已设为 ${role}`);
  return true;
}

/** 删除用户（不能删 grigs） */
export function deleteUser(userId: number): boolean {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === userId);
  if (idx < 0) return false;
  if (users[idx].username === SUPER_ADMIN) return false; // 不可删除
  users.splice(idx, 1);
  saveUsers(users);
  return true;
}

/** 判断是否为管理员 */
export function isAdmin(userId: number): boolean {
  return getUserRole(userId) === 'admin';
}
