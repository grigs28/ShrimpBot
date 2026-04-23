import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';
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

  constructor(deps: WebServerDeps, private port = 5554) {
    this.deps = deps;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.botWss = new WebSocketServer({ noServer: true });

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
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // 首页 — 终端界面（禁缓存）
    this.app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(this.getTerminalPage());
    });

    // API: 获取终端缓冲区文本
    this.app.get('/api/buffer', (_req, res) => {
      res.json({
        text: this.deps.getBufferText?.() || '',
        size: this.deps.getTerminalSize?.() || { cols: 120, rows: 40 },
        botName: this.deps.botName || 'ShrimpBot',
      });
    });

    // API: 发送消息到 Claude
    this.app.post('/api/send', (req, res) => {
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

    // API: 状态（含已连接 bot 列表）
    this.app.get('/api/status', (_req, res) => {
      res.json({
        botName: this.deps.botName || 'ShrimpBot',
        clients: this.clients.size,
        terminal: this.deps.getTerminalSize?.() || { cols: 120, rows: 40 },
        bots: Array.from(this.botConnections.keys()),
      });
    });

    // API: Claude Code Hook 事件 → 转发给指定 bot 或本地回调
    this.app.post('/api/hook', (req, res) => {
      const event = req.body as HookEvent;
      const botName = req.query.bot as string | undefined;
      const keys = Object.keys(req.body);
      const hasTranscript = !!(event as any).transcript_messages;
      const msgCount = hasTranscript ? (event as any).transcript_messages.length : 0;
      logger.info(this.tag, `Hook 原始数据: ${event.hook_event_name}, bot=${botName || 'local'}, keys=[${keys.join(',')}], transcript=${hasTranscript}(${msgCount}条)`);

      if (botName) {
        // 路由到指定 bot
        const ws = this.botConnections.get(botName);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'hook', event }));
        } else {
          logger.warn(this.tag, `Hook 路由失败: bot "${botName}" 未连接`);
        }
      } else {
        // 兜底：广播给所有远程 bot
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
      logger.info(this.tag, `WebSocket 连接: ${ip} (当前: ${this.clients.size + 1})`);
      this.clients.add(ws);

      // 连接后立即发送当前 bot 列表
      ws.send(JSON.stringify({ type: 'bot-list', bots: this.getBotList() }));

      // Web 输入 → 远程 bot 或本地 PTY
      ws.on('message', (msg: Buffer) => {
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
          // 非 JSON 消息 → 兼容旧模式：直接当 PTY 输入
          const data = msg.toString();
          logger.info(this.tag, `Web 输入(原始): ${JSON.stringify(data.slice(0, 50))}`);
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
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(this.tag, `WebSocket 断开: ${ip} (剩余: ${this.clients.size})`);
      });
    });
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

  /** 前端终端页面（支持多咪标签页） */
  private getTerminalPage(): string {
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
  .tab-bar {
    display: none; background: #16213e; padding: 0 16px;
    border-bottom: 1px solid #0f3460; flex-shrink: 0;
    overflow-x: auto; white-space: nowrap;
  }
  .tab-bar.show { display: flex; }
  .tab {
    padding: 8px 16px; font-size: 13px; color: #7f8c8d;
    cursor: pointer; border-bottom: 2px solid transparent;
    transition: all 0.2s; user-select: none;
  }
  .tab:hover { color: #e0e0e0; }
  .tab.on { color: #e94560; border-bottom-color: #e94560; }
  #terms { flex: 1; padding: 4px; overflow: hidden; position: relative; }
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
    <span class="status">
      <span class="dot" id="dot"></span>
      <span id="st">连接中...</span>
    </span>
  </div>
  <div class="tab-bar" id="tabs"></div>
  <div id="terms"></div>
  <div class="foot">
    <span>WebSocket <span id="wsSt">connecting</span></span>
    <span>Ctrl+C 中断 \u00b7 Ctrl+D 退出</span>
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
    var tmap = {};  // botName -> { term, fit, el }
    var active = '';
    var ws = null;
    var rt = null;
    var rd = 1000;

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
        rd = 1000; dot.className = 'dot'; st.textContent = '已连接'; wsSt.textContent = 'connected';
      };
      ws.onmessage = function(e) {
        try {
          var m = JSON.parse(e.data);
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
}
