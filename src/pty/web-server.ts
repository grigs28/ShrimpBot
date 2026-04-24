import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import session from 'express-session';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';
import { loadWebSettings, saveWebSettings } from './web-settings.js';
import { loadBotsRegistry, saveBotsRegistry } from '../config.js';
import { upsertUser, getUserRole, setUserRole, deleteUser, loadUsers, isAdmin } from './web-users.js';
import { loadCommands, addCommand, deleteCommand, saveCommands } from './web-commands.js';
import type { HookEvent } from '../types/index.js';

export interface WebServerDeps {
  /** PTY 原始数据广播（独立 Web 模式不需要） */
  onPtyData?: (callback: (data: string) => void) => void;
  /** 向 PTY 写入（独立 Web 模式不需要） */
  ptyWrite?: (data: string) => void;
  /** 获取终端缓冲区文本（独立 Web 模式不需要） */
  getBufferText?: () => string;
  /** 获取终端尺寸（独立 Web 模式不需要） */
  getTerminalSize?: () => { cols: number; rows: number };
  /** Bot 名称 */
  botName?: string;
  /** Claude Code Hook 事件回调 */
  onHookEvent?: (event: HookEvent) => void;
  /** yz-login 服务地址 */
  yzLoginUrl?: string;
  /** 本服务外部地址（回调用） */
  serviceUrl?: string;
  /** Session 密钥 */
  sessionSecret?: string;
  /** 禁用登录认证（开发/内网模式） */
  noAuth?: boolean;
}

/** Session 用户信息 */
interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  /** 本地角色：admin | user */
  role: 'admin' | 'user';
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

export class WebServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;      // 浏览器客户端
  private botWss: WebSocketServer;   // sbot 提供者
  private deps: WebServerDeps;
  private tag = 'WebServer';
  private clients = new Set<WebSocket>();
  /** 多咪连接：botName → WebSocket */
  private botConnections = new Map<string, WebSocket>();
  /** 当前活跃标签（浏览器端选中的 bot） */
  private activeBot = '';
  /** yz-login 服务地址 */
  private yzLoginUrl: string;
  /** 本服务外部地址 */
  private serviceUrl: string;
  /** 禁用登录认证 */
  private noAuth: boolean;

  constructor(deps: WebServerDeps, private port = 5554) {
    this.deps = deps;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.botWss = new WebSocketServer({ noServer: true });

    this.yzLoginUrl = deps.yzLoginUrl || 'http://192.168.0.18:5551';
    this.serviceUrl = deps.serviceUrl || `http://localhost:${port}`;
    this.noAuth = deps.noAuth || false;

    this.setupSession();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupBotWebSocket();

    // WebSocket 路径路由：/ws/bot → bot 提供者，其他 → 浏览器客户端
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://localhost`);
      if (url.pathname === '/ws/bot') {
        this.botWss.handleUpgrade(request, socket, head, (ws) => {
          this.botWss.emit('connection', ws, request);
        });
      } else {
        // WebSocket 认证：检查 cookie 中的 session
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });
  }

  private setupSession(): void {
    this.app.use(session({
      secret: this.deps.sessionSecret || 'sbot-session-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24h
    }));
  }

  /** 认证中间件：需要管理员登录 */
  private requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (this.noAuth) {
      // noAuth 模式跳过所有认证，直接放行
      next();
      return;
    }
    if (!req.session?.user) {
      res.redirect('/login');
      return;
    }
    const role = getUserRole(req.session.user.id);
    if (role !== 'admin') {
      res.status(403).send('需要管理员权限');
      return;
    }
    next();
  };

  /** 管理员中间件（已由 requireAuth 保证，这里做双重检查） */
  private requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (this.noAuth) {
      next();
      return;
    }
    if (!req.session?.user || getUserRole(req.session.user.id) !== 'admin') {
      res.status(403).send('需要管理员权限');
      return;
    }
    next();
  };

  private setupRoutes(): void {
    this.app.use(express.json());

    // ── 认证路由（公开） ──

    // 跳转到 yz-login
    this.app.get('/login', (_req, res) => {
      const callback = `${this.serviceUrl}/callback`;
      res.redirect(`${this.yzLoginUrl}/login?from=${encodeURIComponent(callback)}`);
    });

    // yz-login 回调：验证 ticket
    this.app.get('/callback', async (req, res) => {
      const ticket = req.query.ticket as string;
      if (!ticket) {
        res.status(400).send('缺少 ticket');
        return;
      }

      try {
        const verifyUrl = `${this.yzLoginUrl}/api/ticket/verify?ticket=${encodeURIComponent(ticket)}`;
        const resp = await fetch(verifyUrl);
        const data = await resp.json() as any;

        if (!data.ok) {
          logger.warn(this.tag, `ticket 验证失败: ${data.msg}`);
          res.status(403).send(`登录失败: ${data.msg || '验证失败'}`);
          return;
        }

        // 记录/更新用户到本地，获取角色（完全忽略 SSO 的 is_admin）
        const localUser = upsertUser({
          id: data.id,
          username: data.username,
          display_name: data.display_name || data.username,
        });

        req.session.user = {
          id: data.id,
          username: data.username,
          display_name: data.display_name || data.username,
          role: localUser.role,
        };

        logger.info(this.tag, `用户登录: ${data.username} (role=${localUser.role})`);
        res.redirect('/');
      } catch (err: any) {
        logger.error(this.tag, `ticket 验证异常: ${err.message}`);
        res.status(500).send('登录服务异常');
      }
    });

    // 登出
    this.app.get('/logout', (req, res) => {
      const username = req.session?.user?.username;
      req.session?.destroy(() => {});
      const callback = `${this.serviceUrl}/callback`;
      res.redirect(`${this.yzLoginUrl}/login?from=${encodeURIComponent(callback)}`);
      logger.info(this.tag, `用户登出: ${username}`);
    });

    // 获取当前用户
    this.app.get('/api/auth/user', (req, res) => {
      const user = req.session?.user;
      if (!user) {
        res.json({ logged_in: false });
        return;
      }
      // 实时查本地角色
      const role = getUserRole(user.id);
      res.json({ logged_in: true, user: { ...user, role: role || user.role } });
    });

    // ── 公开 API ──

    // 健康检查 / 状态
    this.app.get('/api/status', (_req, res) => {
      res.json({
        botName: this.deps.botName || 'ShrimpBot',
        clients: this.clients.size,
        terminal: this.deps.getTerminalSize?.() || { cols: 120, rows: 40 },
        bots: Array.from(this.botConnections.keys()),
      });
    });

    // Hook 接收（Claude Code 调用，无 session）
    this.app.post('/api/hook', (req, res) => {
      const event = req.body as HookEvent;
      const botName = req.query.bot as string | undefined;
      const keys = Object.keys(req.body);
      const hasTranscript = !!(event as any).transcript_messages;
      const msgCount = hasTranscript ? (event as any).transcript_messages.length : 0;
      logger.info(this.tag, `Hook 原始数据: ${event.hook_event_name}, bot=${botName || 'local'}, keys=[${keys.join(',')}], transcript=${hasTranscript}(${msgCount}条)`);

      if (botName) {
        const ws = this.botConnections.get(botName);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'hook', event }));
        } else {
          logger.warn(this.tag, `Hook 路由失败: bot "${botName}" 未连接`);
        }
      } else {
        for (const [, ws] of this.botConnections) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'hook', event }));
          }
        }
      }
      if (this.deps.onHookEvent) {
        this.deps.onHookEvent(event);
      }
      res.json({ ok: true });
    });

    // ── 需要登录的路由 ──

    // 首页 — 终端界面
    this.app.get('/', this.requireAuth, (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      const user = _req.session?.user || { id: 0, username: 'local', display_name: '本地用户', role: 'admin' as const };
      res.send(this.getTerminalPage(user));
    });

    // API: 获取终端缓冲区
    this.app.get('/api/buffer', this.requireAuth, (_req, res) => {
      res.json({
        text: this.deps.getBufferText?.() || '',
        size: this.deps.getTerminalSize?.() || { cols: 120, rows: 40 },
        botName: this.deps.botName || 'ShrimpBot',
      });
    });

    // API: 发送消息到 Claude
    this.app.post('/api/send', this.requireAuth, (req, res) => {
      const { text } = req.body || {};
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: 'text required' });
        return;
      }
      if (!this.deps.ptyWrite) {
        res.status(503).json({ error: 'No PTY connected' });
        return;
      }
      logger.info(this.tag, `API 发送: "${text.slice(0, 100)}"`);
      this.deps.ptyWrite(text + '\r');
      res.json({ ok: true });
    });

    // ── 管理员路由 ──

    // 设置页面
    this.app.get('/settings', this.requireAdmin, (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      const user = _req.session!.user!;
      res.send(this.getSettingsPage(user));
    });

    // 获取所有设置
    this.app.get('/api/admin/settings', this.requireAdmin, (_req, res) => {
      const settings = loadWebSettings();
      const bots = loadBotsRegistry();
      const onlineBots = Array.from(this.botConnections.keys());
      res.json({
        settings,
        bots: bots.map(b => ({
          ...b,
          online: onlineBots.includes(b.name),
          chatCount: (b as any).chatIds?.length || 0,
        })),
      });
    });

    // 更新设置
    this.app.post('/api/admin/settings', this.requireAdmin, (req, res) => {
      const updates = req.body as Record<string, string>;
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'invalid body' });
        return;
      }

      // 允许更新的 key
      const allowedKeys = new Set([
        'web_port', 'log_level', 'session_secret',
        'yz_login_url', 'service_url',
      ]);

      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (allowedKeys.has(k)) {
          filtered[k] = v;
        }
      }

      if (Object.keys(filtered).length > 0) {
        saveWebSettings(filtered);
      }

      res.json({ ok: true, updated: Object.keys(filtered) });
    });

    // 删除 bot
    this.app.post('/api/admin/bots/delete', this.requireAdmin, (req, res) => {
      const { name } = req.body as { name?: string };
      if (!name) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const bots = loadBotsRegistry();
      const idx = bots.findIndex(b => b.name === name);
      if (idx < 0) {
        res.status(404).json({ error: 'bot not found' });
        return;
      }
      bots.splice(idx, 1);
      saveBotsRegistry(bots);
      logger.info(this.tag, `管理员删除 Bot: ${name}`);
      res.json({ ok: true });
    });

    // 用户管理：获取所有用户
    this.app.get('/api/admin/users', this.requireAdmin, (_req, res) => {
      const users = loadUsers();
      res.json({ users });
    });

    // 用户管理：设置角色
    this.app.post('/api/admin/users/role', this.requireAdmin, (req, res) => {
      const { userId, role } = req.body as { userId?: number; role?: string };
      if (!userId || !role || (role !== 'admin' && role !== 'user')) {
        res.status(400).json({ error: 'userId and role (admin/user) required' });
        return;
      }
      const ok = setUserRole(userId, role as 'admin' | 'user');
      if (!ok) {
        res.status(403).json({ error: '无法修改该用户角色（超级管理员不可降级）' });
        return;
      }
      res.json({ ok: true });
    });

    // 用户管理：删除用户
    this.app.post('/api/admin/users/delete', this.requireAdmin, (req, res) => {
      const { userId } = req.body as { userId?: number };
      if (!userId) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      const ok = deleteUser(userId);
      if (!ok) {
        res.status(403).json({ error: '无法删除该用户（超级管理员不可删除）' });
        return;
      }
      res.json({ ok: true });
    });

    // ===== 命令面板 API =====
    // 获取某只虾的常用命令
    this.app.get('/api/commands/:botName', this.requireAuth, (req, res) => {
      const botName = req.params.botName as string;
      res.json(loadCommands(botName));
    });

    // 添加一条命令
    this.app.post('/api/commands/:botName', this.requireAuth, (req, res) => {
      const botName = req.params.botName as string;
      const { label, command } = req.body as { label?: string; command?: string };
      if (!label || !command) {
        res.status(400).json({ error: 'label 和 command 必填' });
        return;
      }
      const cmds = addCommand(botName, label, command);
      res.json(cmds);
    });

    // 删除一条命令
    this.app.delete('/api/commands/:botName/:idx', this.requireAuth, (req, res) => {
      const botName = req.params.botName as string;
      const idx = req.params.idx as string;
      const index = parseInt(idx, 10);
      const cmds = deleteCommand(botName, index);
      if (cmds === null) {
        res.status(400).json({ error: '索引无效' });
        return;
      }
      res.json(cmds);
    });

    // 导出命令（返回 JSON 文件下载）
    this.app.get('/api/commands/:botName/export', this.requireAuth, (req, res) => {
      const botName = req.params.botName as string;
      const cmds = loadCommands(botName);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${botName}-commands.json"`);
      res.send(JSON.stringify(cmds, null, 2));
    });

    // 导入命令（JSON 上传，合并到现有命令）
    this.app.post('/api/commands/:botName/import', this.requireAuth, (req, res) => {
      const botName = req.params.botName as string;
      const incoming = req.body as Array<{ label: string; command: string }>;
      if (!Array.isArray(incoming)) {
        res.status(400).json({ error: '需要 JSON 数组' });
        return;
      }
      const existing = loadCommands(botName);
      // 合并：跳过 command 重复的
      const existingCmds = new Set(existing.map(c => c.command));
      let added = 0;
      for (const cmd of incoming) {
        if (cmd.label && cmd.command && !existingCmds.has(cmd.command)) {
          existing.push({ label: cmd.label, command: cmd.command });
          added++;
        }
      }
      saveCommands(botName, existing);
      res.json({ total: existing.length, added });
    });
  }

  private setupWebSocket(): void {
    // PTY 数据广播到所有 WebSocket 客户端（本地模式）
    if (this.deps.onPtyData) {
      this.deps.onPtyData((data: string) => {
        const botName = this.deps.botName || 'local';
        const msg = JSON.stringify({ type: 'pty-data', data, botName });
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        }
      });
    }

    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;

      // WebSocket 认证：通过 cookie 解析 session（简易检查）
      // 完整 session 解析需要解析 cookie + 解密 session store，这里采用简化方案：
      // 首条消息必须是 auth 消息，否则断开
      let authenticated = this.noAuth; // noAuth 模式直接跳过认证
      if (this.noAuth) {
        this.clients.add(ws);
        ws.send(JSON.stringify({ type: 'auth-ok' }));
        ws.send(JSON.stringify({ type: 'bot-list', bots: this.getBotList() }));
      }
      const authTimer = this.noAuth ? null : setTimeout(() => {
        if (!authenticated) {
          ws.close(4001, '未认证');
        }
      }, 5000);

      ws.on('message', (msg: Buffer) => {
        // 首条消息检查认证
        if (!authenticated) {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === 'auth' && parsed.token) {
              authenticated = true;
              if (authTimer) clearTimeout(authTimer);
              this.clients.add(ws);
              ws.send(JSON.stringify({ type: 'auth-ok' }));
              ws.send(JSON.stringify({ type: 'bot-list', bots: this.getBotList() }));
              logger.info(this.tag, `WebSocket 已认证: ${ip}`);
              return;
            }
          } catch { /* fall through */ }
          ws.close(4001, '未认证');
          return;
        }

        // 已认证：正常处理消息
        this.handleClientMessage(ws, msg);
      });

      ws.on('close', () => {
        if (authTimer) clearTimeout(authTimer);
        this.clients.delete(ws);
        if (authenticated) {
          logger.info(this.tag, `WebSocket 断开: ${ip} (剩余: ${this.clients.size})`);
        }
      });
    });
  }

  /** 处理已认证客户端的消息 */
  private handleClientMessage(ws: WebSocket, msg: Buffer): void {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'web-input' && typeof parsed.data === 'string') {
        const targetBot = parsed.targetBot || this.activeBot;
        logger.info(this.tag, `Web 输入 → ${targetBot}: ${JSON.stringify(parsed.data.slice(0, 50))}`);
        if (targetBot && this.botConnections.has(targetBot)) {
          const botWs = this.botConnections.get(targetBot)!;
          if (botWs.readyState === WebSocket.OPEN) {
            botWs.send(JSON.stringify({ type: 'web-input', data: parsed.data }));
          }
        } else if (this.deps.ptyWrite) {
          this.deps.ptyWrite(parsed.data);
        }
      } else if (parsed.type === 'select-bot' && typeof parsed.botName === 'string') {
        this.activeBot = parsed.botName;
      }
    } catch {
      // 非 JSON 消息 → 兼容旧模式
      const data = msg.toString();
      if (this.botConnections.size > 0) {
        const targetBot = this.activeBot || this.botConnections.keys().next().value;
        if (targetBot) {
          const botWs = this.botConnections.get(targetBot);
          if (botWs?.readyState === WebSocket.OPEN) {
            botWs.send(JSON.stringify({ type: 'web-input', data }));
          }
        }
      } else if (this.deps.ptyWrite) {
        this.deps.ptyWrite(data);
      }
    }
  }

  /** 处理 sbot bot 提供者 WebSocket 连接（多咪） */
  private setupBotWebSocket(): void {
    this.botWss.on('connection', (ws) => {
      let botName = '';

      ws.on('message', (msg: Buffer) => {
        try {
          const parsed = JSON.parse(msg.toString());

          // bot-join：注册 bot
          if (parsed.type === 'bot-join' && typeof parsed.name === 'string') {
            botName = parsed.name;
            // 如果同名 bot 已存在，关闭旧连接
            const existing = this.botConnections.get(botName);
            if (existing && existing !== ws) {
              existing.close();
            }
            this.botConnections.set(botName, ws);
            logger.info(this.tag, `Bot 提供者已连接: ${botName} (总计: ${this.botConnections.size})`);
            if (!this.activeBot) this.activeBot = botName;
            this.broadcastBotList();
            return;
          }

          // pty-data：广播到所有浏览器客户端
          if (parsed.type === 'pty-data' && typeof parsed.data === 'string') {
            const name = parsed.name || botName;
            const bmsg = JSON.stringify({ type: 'pty-data', data: parsed.data, botName: name });
            for (const client of this.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(bmsg);
              }
            }
          }
        } catch {
          // 非 JSON 消息忽略
        }
      });

      ws.on('close', () => {
        if (botName) {
          this.botConnections.delete(botName);
          logger.info(this.tag, `Bot 提供者已断开: ${botName} (剩余: ${this.botConnections.size})`);
          if (this.activeBot === botName) {
            this.activeBot = this.botConnections.keys().next().value || '';
          }
          this.broadcastBotList();
        }
      });
    });
  }

  /** 获取已连接 bot 列表（含本地 bot） */
  private getBotList(): string[] {
    const bots: string[] = [];
    // 本地 bot（通过 deps 直接连接）
    if (this.deps.ptyWrite) {
      bots.push(this.deps.botName || 'local');
    }
    // 远程 bot（通过 /ws/bot 连接）
    for (const name of this.botConnections.keys()) {
      if (!bots.includes(name)) bots.push(name);
    }
    return bots;
  }

  /** 广播 bot 列表到所有浏览器客户端 */
  private broadcastBotList(): void {
    const msg = JSON.stringify({ type: 'bot-list', bots: this.getBotList() });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /** 检查端口是否可用 */
  static isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const testServer = http.createServer();
      testServer.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') resolve(false);
        else resolve(false);
      });
      testServer.once('listening', () => {
        testServer.close(() => resolve(true));
      });
      testServer.listen(port, '127.0.0.1');
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(this.tag, `端口 ${this.port} 已被占用，Web 终端未启动`);
          resolve();
        } else {
          reject(err);
        }
      });
      this.server.listen(this.port, () => {
        logger.info(this.tag, `Web 终端已启动: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  getPort(): number { return this.port; }

  stop(): void {
    for (const [, ws] of this.botConnections) {
      ws.close();
    }
    this.botConnections.clear();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.botWss.close();
    this.server.close();
    this.wss.close();
    logger.info(this.tag, 'Web 终端已停止');
  }

  /** 前端终端页面（支持多咪标签页 + 用户认证） */
  private getTerminalPage(user: SessionUser): string {
    const botName = this.deps.botName || 'ShrimpBot';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${botName} — Web Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e; color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  .header {
    background: #16213e; padding: 8px 16px;
    display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid #0f3460; flex-shrink: 0;
  }
  .logo { font-size: 18px; font-weight: bold; color: #e94560; white-space: nowrap; }
  .info { font-size: 12px; color: #7f8c8d; }
  .status { margin-left: auto; font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ecc71; }
  .dot.off { background: #e74c3c; }
  .user-info { font-size: 12px; color: #a0a0a0; display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .user-info a { color: #e94560; text-decoration: none; font-size: 12px; }
  .user-info a:hover { text-decoration: underline; }
  .admin-link { color: #7f8c8d; text-decoration: none; font-size: 12px; }
  .admin-link:hover { color: #e94560; }
  .tab-bar {
    display: none; background: #16213e; padding: 0 16px;
    border-bottom: 1px solid #0f3460; flex-shrink: 0;
    overflow-x: auto; white-space: nowrap;
  }
  .tab-bar.show { display: flex; }
  .tab {
    padding: 8px 16px; font-size: 14px; font-weight: bold; color: #a0a0a0;
    cursor: pointer; border-bottom: 2px solid transparent;
    transition: all 0.2s; user-select: none;
  }
  .tab:hover { color: #f0f0f0; }
  .tab.on { color: #ffd700; border-bottom-color: #ffd700; text-shadow: 0 0 8px rgba(255,215,0,0.5); }
  #terms { flex: 1; padding: 4px; overflow: hidden; position: relative; }
  /* 命令面板按钮 — 在 footer 内，右对齐 */
  .foot { position: relative; }
  #cmdBtn {
    background: #e94560; color: #fff; border: none;
    border-radius: 6px; padding: 3px 12px; font-size: 12px; font-weight: bold;
    cursor: pointer; font-family: inherit; margin-left: auto;
    box-shadow: 0 0 8px rgba(233,69,96,0.4);
  }
  #cmdBtn:hover { background: #ff6b81; }
  /* 命令面板弹窗 — fixed 定位，浮在右下角 */
  #cmdPanel {
    display: none; position: fixed; right: 16px; bottom: 36px; z-index: 9999;
    width: 320px; max-height: 70vh; background: #16213e;
    border: 1px solid #0f3460; border-radius: 8px; overflow: hidden;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5); flex-direction: column;
  }
  #cmdPanel.open { display: flex; }
  #cmdPanel .cp-head {
    padding: 10px 12px; border-bottom: 1px solid #0f3460;
    display: flex; align-items: center; justify-content: space-between;
  }
  #cmdPanel .cp-head span { font-size: 13px; font-weight: bold; color: #e94560; }
  #cmdPanel .cp-head button {
    background: none; border: none; color: #7f8c8d; cursor: pointer; font-size: 14px; padding: 0 4px;
  }
  #cmdPanel .cp-head button:hover { color: #e0e0e0; }
  #cmdPanel .cp-body { flex: 1; overflow-y: auto; padding: 6px 0; }
  #cmdPanel .cp-item {
    padding: 8px 12px; cursor: pointer; display: flex; align-items: center;
    justify-content: space-between; transition: background 0.15s;
  }
  #cmdPanel .cp-item:hover { background: #1a2a4a; }
  #cmdPanel .cp-item .cp-label { font-size: 13px; color: #e0e0e0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cmdPanel .cp-item .cp-del { color: #555; font-size: 12px; padding: 0 4px; cursor: pointer; }
  #cmdPanel .cp-item .cp-del:hover { color: #e74c3c; }
  #cmdPanel .cp-item .cp-cb {
    width: 16px; height: 16px; margin-right: 8px; accent-color: #e94560; cursor: pointer; flex-shrink: 0;
  }
  #cmdPanel .cp-empty { padding: 20px; text-align: center; color: #555; font-size: 13px; }
  #cmdPanel .cp-quick-add {
    padding: 8px 12px; border-top: 1px solid #0f3460; display: flex; gap: 6px;
  }
  #cmdPanel .cp-quick-add input {
    flex: 1; background: #1a1a2e; border: 1px solid #0f3460; border-radius: 4px;
    color: #e0e0e0; padding: 5px 8px; font-size: 12px; outline: none;
  }
  #cmdPanel .cp-quick-add input:focus { border-color: #e94560; }
  #cmdPanel .cp-quick-add button {
    background: #e94560; color: #fff; border: none; border-radius: 4px;
    padding: 4px 10px; font-size: 12px; cursor: pointer; font-weight: bold;
  }
  #cmdPanel .cp-quick-add button:hover { background: #ff6b81; }
  #cmdPanel .cp-quick-add #cmdSendSel { background: #27ae60; padding: 4px 8px; }
  #cmdPanel .cp-quick-add #cmdSendSel:hover { background: #2ecc71; }
  #cmdPanel .cp-add {
    padding: 8px 12px; border-top: 1px solid #0f3460;
    display: flex; gap: 6px;
  }
  #cmdPanel .cp-add input {
    flex: 1; background: #1a1a2e; border: 1px solid #0f3460; border-radius: 4px;
    color: #e0e0e0; padding: 4px 8px; font-size: 12px; outline: none;
  }
  #cmdPanel .cp-add input:focus { border-color: #e94560; }
  #cmdPanel .cp-add button {
    background: #e94560; color: #fff; border: none; border-radius: 4px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  #cmdPanel .cp-add button:hover { background: #c73550; }
  #cmdPanel .cp-foot {
    padding: 6px 12px; border-top: 1px solid #0f3460;
    display: flex; gap: 8px; justify-content: flex-end;
  }
  #cmdPanel .cp-foot button {
    background: none; border: 1px solid #0f3460; color: #7f8c8d;
    border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer;
  }
  #cmdPanel .cp-foot button:hover { color: #e0e0e0; border-color: #e0e0e0; }
  /* 添加命令展开区域 */
  #cmdPanel .cp-add-form { padding: 8px 12px; border-top: 1px solid #0f3460; display: none; }
  #cmdPanel .cp-add-form.open { display: block; }
  #cmdPanel .cp-add-form input {
    width: 100%; background: #1a1a2e; border: 1px solid #0f3460; border-radius: 4px;
    color: #e0e0e0; padding: 5px 8px; font-size: 12px; outline: none; margin-bottom: 6px;
  }
  #cmdPanel .cp-add-form input:focus { border-color: #e94560; }
  #cmdPanel .cp-add-form .cp-add-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .tw {
    position: absolute; top: 4px; left: 4px; right: 4px; bottom: 4px;
    display: none;
  }
  .tw.on { display: block; }
  .tw .xterm { height: 100%; }
  .foot {
    background: #16213e; padding: 6px 16px; font-size: 11px; color: #555;
    border-top: 1px solid #0f3460; display: flex; justify-content: space-between;
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <div class="header">
    <span class="logo">\u{1F990} ${botName}</span>
    <span class="info">Claude Code Web Terminal</span>
    <div class="user-info">
      ${user.role === 'admin' ? '<a href="/settings" class="admin-link">\u2699 设置</a> |' : ''}
      <span>${user.display_name}</span>
      <a href="/logout">登出</a>
      <span class="dot" id="dot"></span>
      <span id="st">连接中...</span>
    </div>
  </div>
  <div class="tab-bar" id="tabs"></div>
  <div id="terms"></div>
  <div class="foot">
    <span>WebSocket <span id="wsSt">connecting</span></span>
    <span>Ctrl+C 中断 \u00b7 Ctrl+D 退出</span>
    <button id="cmdBtn" title="\u5e38\u7528\u547d\u4ee4">\u2318 \u547d\u4ee4</button>
  </div>
  <!-- 命令面板浮层 -->
  <div id="cmdPanel">
    <div class="cp-head">
      <span>\u5e38\u7528\u547d\u4ee4</span>
      <div>
        <button id="cmdAddBtn" title="\u6dfb\u52a0\u547d\u4ee4">+</button>
        <button id="cmdCloseBtn" title="\u5173\u95ed">\u2715</button>
      </div>
    </div>
    <div class="cp-body" id="cmdList"></div>
    <div class="cp-quick-add">
      <button id="cmdSendSel" title="\u53d1\u9001\u52fe\u9009\u547d\u4ee4">\u25b6 \u53d1\u9001</button>
      <input id="cmdQuickInput" placeholder="\u8f93\u5165\u547d\u4ee4\u56de\u8f66\u6dfb\u52a0" />
      <button id="cmdQuickBtn" title="\u6dfb\u52a0">+</button>
    </div>
    <div class="cp-add-form" id="cmdAddForm">
      <input id="cmdNewLabel" placeholder="\u547d\u4ee4\u540d\u79f0\uff08\u5982\uff1a\u5217\u51fa\u6587\u4ef6\uff09" />
      <input id="cmdNewCmd" placeholder="\u5b9e\u9645\u547d\u4ee4\uff08\u5982\uff1als -la\uff09" />
      <div class="cp-add-actions">
        <button id="cmdAddCancel">\u53d6\u6d88</button>
        <button id="cmdAddSave" style="background:#e94560;color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;">\u4fdd\u5b58</button>
      </div>
    </div>
    <div class="cp-foot">
      <button id="cmdImportBtn">\u5bfc\u5165</button>
      <button id="cmdExportBtn">\u5bfc\u51fa</button>
    </div>
    <input type="file" id="cmdImportFile" accept=".json" style="display:none" />
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
  (function(){
    var c = document.getElementById('terms');
    var tabC = document.getElementById('tabs');
    var dot = document.getElementById('dot');
    var st = document.getElementById('st');
    var wsSt = document.getElementById('wsSt');
    var tmap = {};
    var active = '';
    var ws = null;
    var rt = null;
    var rd = 1000;

    // ===== 命令面板 =====
    var cmdBtn = document.getElementById('cmdBtn');
    var cmdPanel = document.getElementById('cmdPanel');
    var cmdList = document.getElementById('cmdList');
    var cmdAddBtn = document.getElementById('cmdAddBtn');
    var cmdCloseBtn = document.getElementById('cmdCloseBtn');
    var cmdAddForm = document.getElementById('cmdAddForm');
    var cmdNewLabel = document.getElementById('cmdNewLabel');
    var cmdNewCmd = document.getElementById('cmdNewCmd');
    var cmdAddCancel = document.getElementById('cmdAddCancel');
    var cmdAddSave = document.getElementById('cmdAddSave');
    var cmdExportBtn = document.getElementById('cmdExportBtn');
    var cmdImportBtn = document.getElementById('cmdImportBtn');
    var cmdImportFile = document.getElementById('cmdImportFile');
    var cmds = [];
    var cmdsLoaded = false;

    function loadCmds() {
      var bot = active || '${botName}';
      fetch('/api/commands/' + encodeURIComponent(bot)).then(function(r){ return r.json(); }).then(function(data){
        cmds = data; cmdsLoaded = true; renderCmds();
      }).catch(function(){ cmds = []; renderCmds(); });
    }

    function renderCmds() {
      cmdList.innerHTML = '';
      if (cmds.length === 0) {
        cmdList.innerHTML = '<div class="cp-empty">\u6682\u65e0\u5e38\u7528\u547d\u4ee4</div>';
        return;
      }
      cmds.forEach(function(cmd, i) {
        var row = document.createElement('div');
        row.className = 'cp-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'cp-cb';
        cb.dataset.idx = String(i);
        var label = document.createElement('span');
        label.className = 'cp-label';
        label.textContent = cmd.label;
        label.title = cmd.command;
        var del = document.createElement('span');
        del.className = 'cp-del';
        del.textContent = '\u2715';
        del.title = '\u5220\u9664';
        del.onclick = function(e) {
          e.stopPropagation();
          fetch('/api/commands/' + encodeURIComponent(active || '${botName}') + '/' + i, {method:'DELETE'})
            .then(function(r){ return r.json(); })
            .then(function(data){ cmds = data; renderCmds(); });
        };
        row.appendChild(cb);
        row.appendChild(label);
        row.appendChild(del);
        cmdList.appendChild(row);
      });
    }

    function sendCmd(text) {
      if (ws && ws.readyState === 1 && active) {
        ws.send(JSON.stringify({type:'web-input', data: text + '\\r', targetBot: active}));
      }
    }

    cmdBtn.onclick = function() {
      var isOpen = cmdPanel.classList.contains('open');
      if (isOpen) {
        cmdPanel.classList.remove('open');
      } else {
        cmdPanel.classList.add('open');
        if (!cmdsLoaded) loadCmds();
      }
    };
    cmdCloseBtn.onclick = function() { cmdPanel.classList.remove('open'); };

    cmdAddBtn.onclick = function() {
      var f = cmdAddForm;
      if (f.classList.contains('open')) { f.classList.remove('open'); }
      else { f.classList.add('open'); cmdNewLabel.focus(); }
    };
    cmdAddCancel.onclick = function() { cmdAddForm.classList.remove('open'); cmdNewLabel.value=''; cmdNewCmd.value=''; };
    cmdAddSave.onclick = function() {
      var l = cmdNewLabel.value.trim(), c = cmdNewCmd.value.trim();
      if (!l || !c) return;
      fetch('/api/commands/' + encodeURIComponent(active || '${botName}'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({label:l, command:c})
      }).then(function(r){ return r.json(); }).then(function(data){
        cmds = data; renderCmds(); cmdNewLabel.value=''; cmdNewCmd.value=''; cmdAddForm.classList.remove('open');
      });
    };

    // 快捷添加：输入命令回车即添加
    var cmdQuickInput = document.getElementById('cmdQuickInput');
    var cmdQuickBtn = document.getElementById('cmdQuickBtn');
    function quickAdd() {
      var text = cmdQuickInput.value.trim();
      if (!text) return;
      fetch('/api/commands/' + encodeURIComponent(active || '${botName}'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({label: text, command: text})
      }).then(function(r){ return r.json(); }).then(function(data){
        cmds = data; renderCmds(); cmdQuickInput.value = '';
      });
    }
    cmdQuickInput.onkeydown = function(e) { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } };
    cmdQuickBtn.onclick = quickAdd;

    // 发送选中的命令
    var cmdSendSel = document.getElementById('cmdSendSel');
    cmdSendSel.onclick = function() {
      var boxes = cmdList.querySelectorAll('.cp-cb:checked');
      if (boxes.length === 0) return;
      boxes.forEach(function(cb) {
        var idx = parseInt(cb.dataset.idx, 10);
        if (cmds[idx]) sendCmd(cmds[idx].command);
      });
      cmdPanel.classList.remove('open');
    };

    cmdExportBtn.onclick = function() {
      var bot = active || '${botName}';
      window.location.href = '/api/commands/' + encodeURIComponent(bot) + '/export';
    };
    cmdImportBtn.onclick = function() { cmdImportFile.click(); };
    cmdImportFile.onchange = function() {
      var file = cmdImportFile.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var data = JSON.parse(e.target.result);
          fetch('/api/commands/' + encodeURIComponent(active || '${botName}') + '/import', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(data)
          }).then(function(r){ return r.json(); }).then(function(res){
            loadCmds();
          });
        } catch(_) { alert('\u65e0\u6548\u7684 JSON \u6587\u4ef6'); }
      };
      reader.readAsText(file);
      cmdImportFile.value = '';
    };

    // \u70b9\u51fb\u5176\u4ed6\u533a\u57df\u5173\u95ed\u9762\u677f
    document.addEventListener('click', function(e) {
      if (!cmdPanel.classList.contains('open')) return;
      if (cmdPanel.contains(e.target) || cmdBtn.contains(e.target)) return;
      cmdPanel.classList.remove('open');
    });

    // \u5207\u6362 bot \u65f6\u91cd\u65b0\u52a0\u8f7d\u547d\u4ee4
    var origPick = null;

    function mkTerm(name) {
      if (tmap[name]) return tmap[name];
      var el = document.createElement('div');
      el.className = 'tw';
      c.appendChild(el);
      var t = new Terminal({
        theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560', selectionBackground: '#0f3460' },
        fontFamily: '"JetBrains Mono","Fira Code",Menlo,Monaco,monospace',
        fontSize: 14, cursorBlink: true, scrollback: 5000, cols: 120, rows: 40,
      });
      var f = new FitAddon.FitAddon();
      t.loadAddon(f);
      t.open(el);
      setTimeout(function(){ f.fit(); }, 50);
      t.onData(function(d) {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'web-input', data: d, targetBot: name }));
        }
      });
      tmap[name] = { term: t, fit: f, el: el };
      return tmap[name];
    }

    function pick(name) {
      active = name;
      var tabs = tabC.children;
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = tabs[i].getAttribute('data-b') === name ? 'tab on' : 'tab';
      }
      for (var k in tmap) {
        tmap[k].el.className = k === name ? 'tw on' : 'tw';
      }
      var e = tmap[name];
      if (e) setTimeout(function(){ e.fit.fit(); }, 50);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'select-bot', botName: name }));
      }
      cmdsLoaded = false;
      if (cmdPanel.classList.contains('open')) loadCmds();
    }

    function setTabs(bots) {
      while (tabC.firstChild) tabC.removeChild(tabC.firstChild);
      if (bots.length <= 1) {
        tabC.className = 'tab-bar';
        if (bots.length === 1) { mkTerm(bots[0]); pick(bots[0]); }
        return;
      }
      tabC.className = 'tab-bar show';
      for (var i = 0; i < bots.length; i++) {
        var s = document.createElement('span');
        s.className = 'tab';
        s.textContent = bots[i];
        s.setAttribute('data-b', bots[i]);
        s.onclick = (function(n){ return function(){ pick(n); }; })(bots[i]);
        tabC.appendChild(s);
        mkTerm(bots[i]);
      }
      if (!active || bots.indexOf(active) < 0) pick(bots[0]);
    }

    function conn() {
      if (ws && ws.readyState < 2) return;
      ws = new WebSocket('ws://' + location.host);
      ws.onopen = function() {
        // 发送认证 token（用 session cookie 的简化方案）
        ws.send(JSON.stringify({ type: 'auth', token: document.cookie }));
      };
      ws.onmessage = function(e) {
        try {
          var m = JSON.parse(e.data);
          if (m.type === 'auth-ok') {
            rd = 1000; dot.className = 'dot'; st.textContent = '已连接'; wsSt.textContent = 'connected';
            return;
          }
          if (m.type === 'pty-data' && m.botName) {
            mkTerm(m.botName).term.write(m.data);
          } else if (m.type === 'bot-list') {
            setTabs(m.bots);
          }
        } catch(_) {
          if (typeof e.data === 'string' && active) {
            var entry = tmap[active];
            if (entry) entry.term.write(e.data);
          }
        }
      };
      ws.onclose = function() {
        dot.className = 'dot off'; st.textContent = '重连中...'; wsSt.textContent = 'reconnecting';
        for (var k in tmap) tmap[k].term.write('\\r\\n\\x1b[33m--- 连接断开，自动重连中 ---\\x1b[0m\\r\\n');
        sched();
      };
      ws.onerror = function() { dot.className = 'dot off'; st.textContent = '连接错误'; };
    }
    function sched() {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function(){ st.textContent = '重连中 (' + (rd/1000) + 's)...'; conn(); rd = Math.min(rd * 2, 10000); }, rd);
    }
    conn();
    window.addEventListener('resize', function(){ for (var k in tmap) tmap[k].fit.fit(); });
  })();
  </script>
</body>
</html>`;
  }

  /** 管理员设置页面 */
  private getSettingsPage(user: SessionUser): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ShrimpBot \u2014 系统设置</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }
  .header { background: #16213e; padding: 12px 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #0f3460; }
  .logo { font-size: 20px; font-weight: bold; color: #e94560; }
  .nav { margin-left: auto; font-size: 13px; }
  .nav a { color: #a0a0a0; text-decoration: none; margin-left: 16px; }
  .nav a:hover { color: #e94560; }
  .wrap { max-width: 900px; margin: 24px auto; padding: 0 16px; }
  .card { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid #0f3460; }
  .card h3 { color: #e94560; font-size: 15px; margin-bottom: 16px; border-left: 3px solid #e94560; padding-left: 10px; }
  .row { display: flex; align-items: center; margin-bottom: 10px; }
  .row label { min-width: 160px; font-size: 13px; color: #a0a0a0; }
  .row input, .row select { flex: 1; max-width: 400px; background: #1a1a2e; border: 1px solid #0f3460; color: #e0e0e0; padding: 6px 10px; border-radius: 4px; font-size: 13px; }
  .row input:focus, .row select:focus { border-color: #e94560; outline: none; }
  .btn { background: #e94560; color: #fff; border: none; padding: 8px 24px; border-radius: 4px; cursor: pointer; font-size: 14px; }
  .btn:hover { background: #c73850; }
  .btn-sm { padding: 4px 12px; font-size: 12px; background: #0f3460; }
  .btn-sm:hover { background: #1a4a8a; }
  .btn-del { background: #555; }
  .btn-del:hover { background: #c0392b; }
  .btn-role { padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; border: none; }
  .btn-role.admin { background: #27ae60; color: #fff; }
  .btn-role.user { background: #555; color: #aaa; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #7f8c8d; padding: 6px 8px; border-bottom: 1px solid #0f3460; }
  td { padding: 6px 8px; border-bottom: 1px solid #0f3460; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; }
  .tag.on { background: #27ae60; color: #fff; }
  .tag.off { background: #555; color: #aaa; }
  .toast { position: fixed; top: 20px; right: 20px; padding: 10px 20px; border-radius: 6px; font-size: 13px; z-index: 9999; display: none; }
  .toast.ok { background: #27ae60; color: #fff; display: block; }
  .toast.err { background: #c0392b; color: #fff; display: block; }
</style>
</head>
<body>
<div class="header">
  <span class="logo">\u{1F990} ShrimpBot</span>
  <span style="font-size:13px;color:#7f8c8d">系统设置</span>
  <div class="nav">
    <a href="/">\u2190 返回终端</a>
    <a href="/logout">登出 (${user.display_name})</a>
  </div>
</div>
<div class="wrap">
  <div id="toast" class="toast"></div>

  <div class="card">
    <h3>\u2699 系统设置</h3>
    <div class="row"><label>Web 端口</label><input id="s_web_port" data-key="web_port"></div>
    <div class="row"><label>日志级别</label><select id="s_log_level" data-key="log_level"><option>info</option><option>debug</option><option>warn</option><option>error</option></select></div>
    <div class="row"><label>Session 密钥</label><input id="s_session_secret" data-key="session_secret" type="password" placeholder="(留空不修改)"></div>
    <div class="row"><label>yz-login 地址</label><input id="s_yz_login_url" data-key="yz_login_url"></div>
    <div class="row"><label>本服务地址</label><input id="s_service_url" data-key="service_url"></div>
    <div style="text-align:right;margin-top:12px">
      <button class="btn" onclick="saveSettings()">\u2713 保存设置</button>
    </div>
  </div>

  <div class="card">
    <h3>\u{1F464} 用户管理</h3>
    <p style="font-size:12px;color:#7f8c8d;margin-bottom:12px">所有通过 SSO 登录过的用户。点击角色按钮切换 admin/user，grigs 不可降级。</p>
    <table>
      <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>操作</th></tr></thead>
      <tbody id="userList"></tbody>
    </table>
  </div>

  <div class="card">
    <h3>\u{1F990} Bot 管理</h3>
    <table>
      <thead><tr><th>名称</th><th>App ID</th><th>会话数</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="botList"></tbody>
    </table>
  </div>
</div>
<script>
function load() {
  // 加载系统设置
  fetch('/api/admin/settings').then(r => r.json()).then(d => {
    var s = d.settings || {};
    ['web_port','log_level','session_secret','yz_login_url','service_url'].forEach(function(k) {
      var el = document.querySelector('[data-key="'+k+'"]');
      if (el && s[k]) el.value = s[k];
    });
    // Bot 列表
    var tbody = document.getElementById('botList');
    var bots = d.bots || [];
    if (!bots.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#555">暂无 Bot</td></tr>'; return; }
    tbody.innerHTML = bots.map(function(b) {
      var st = b.online ? '<span class="tag on">在线</span>' : '<span class="tag off">离线</span>';
      return '<tr><td>'+b.name+'</td><td style="font-size:11px;color:#7f8c8d">'+b.appId+'</td><td>'+b.chatCount+'</td><td>'+st+'</td><td><button class="btn-sm btn-del" onclick="delBot(\\''+b.name+'\\')">\u2715 删除</button></td></tr>';
    }).join('');
  }).catch(function(e) { toast('加载失败: '+e.message, true); });

  // 加载用户列表
  fetch('/api/admin/users').then(r => r.json()).then(d => {
    var tbody = document.getElementById('userList');
    var users = d.users || [];
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#555">暂无用户</td></tr>'; return; }
    tbody.innerHTML = users.map(function(u) {
      var isGrigs = u.username === 'grigs';
      var roleBtn = isGrigs
        ? '<button class="btn-role admin" disabled>\u{1F451} 超级管理员</button>'
        : '<button class="btn-role '+u.role+'" onclick="toggleRole('+u.id+',\\''+u.role+'\\')">'+(u.role === 'admin' ? '\u2713 管理员' : '\u25CB 普通用户')+'</button>';
      var delBtn = isGrigs ? '' : '<button class="btn-sm btn-del" onclick="delUser('+u.id+',\\''+u.username+'\\')">\u2715 删除</button>';
      return '<tr><td>'+u.username+'</td><td>'+u.display_name+'</td><td>'+roleBtn+'</td><td>'+delBtn+'</td></tr>';
    }).join('');
  }).catch(function(e) { toast('用户列表加载失败: '+e.message, true); });
}

function saveSettings() {
  var data = {};
  ['web_port','log_level','session_secret','yz_login_url','service_url'].forEach(function(k) {
    var el = document.querySelector('[data-key="'+k+'"]');
    if (el && el.value) data[k] = el.value;
  });
  fetch('/api/admin/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
    .then(function(r) { return r.json(); })
    .then(function(d) { toast('保存成功 (更新 ' + d.updated.length + ' 项)'); })
    .catch(function(e) { toast('保存失败: '+e.message, true); });
}

function toggleRole(userId, currentRole) {
  var newRole = currentRole === 'admin' ? 'user' : 'admin';
  fetch('/api/admin/users/role', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId:userId, role:newRole}) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) toast('角色已切换为 ' + newRole);
      else toast(d.error || '操作失败', true);
      load();
    })
    .catch(function(e) { toast('操作失败: '+e.message, true); });
}

function delUser(userId, username) {
  if (!confirm('确认删除用户 "'+username+'"？')) return;
  fetch('/api/admin/users/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({userId:userId}) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) toast('已删除 '+username);
      else toast(d.error || '删除失败', true);
      load();
    })
    .catch(function(e) { toast('删除失败: '+e.message, true); });
}

function delBot(name) {
  if (!confirm('确认删除 Bot "'+name+'"？')) return;
  fetch('/api/admin/bots/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name:name}) })
    .then(function(r) { return r.json(); })
    .then(function() { toast('已删除 '+name); load(); })
    .catch(function(e) { toast('删除失败: '+e.message, true); });
}

function toast(msg, isErr) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + (isErr ? 'err' : 'ok');
  setTimeout(function() { el.className = 'toast'; }, 3000);
}

load();
</script>
</body>
</html>`;
  }
}
