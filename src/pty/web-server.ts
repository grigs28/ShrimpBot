import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';

export interface WebServerDeps {
  /** PTY 原始数据广播 */
  onPtyData: (callback: (data: string) => void) => void;
  /** 向 PTY 写入 */
  ptyWrite: (data: string) => void;
  /** 获取终端缓冲区文本 */
  getBufferText: () => string;
  /** 获取终端尺寸 */
  getTerminalSize: () => { cols: number; rows: number };
  /** Bot 名称 */
  botName?: string;
}

export class WebServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private deps: WebServerDeps;
  private tag = 'WebServer';
  private clients = new Set<WebSocket>();

  constructor(deps: WebServerDeps, private port = 5554) {
    this.deps = deps;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // 首页 — 终端界面
    this.app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(this.getTerminalPage());
    });

    // API: 获取终端缓冲区文本
    this.app.get('/api/buffer', (_req, res) => {
      res.json({
        text: this.deps.getBufferText(),
        size: this.deps.getTerminalSize(),
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
      logger.info(this.tag, `API 发送: "${text.slice(0, 100)}"`);
      this.deps.ptyWrite(text + '\r');
      res.json({ ok: true });
    });

    // API: 状态
    this.app.get('/api/status', (_req, res) => {
      res.json({
        botName: this.deps.botName || 'ShrimpBot',
        clients: this.clients.size,
        terminal: this.deps.getTerminalSize(),
      });
    });
  }

  private setupWebSocket(): void {
    // PTY 数据广播到所有 WebSocket 客户端
    this.deps.onPtyData((data: string) => {
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    });

    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      logger.info(this.tag, `WebSocket 连接: ${ip} (当前: ${this.clients.size + 1})`);
      this.clients.add(ws);

      // 发送当前缓冲区内容（让新客户端看到历史）
      const currentBuffer = this.deps.getBufferText();
      if (currentBuffer) {
        ws.send(currentBuffer);
      }

      // Web 输入 → PTY（记录日志）
      ws.on('message', (msg: Buffer) => {
        const data = msg.toString();
        logger.info(this.tag, `Web 输入: ${JSON.stringify(data.slice(0, 50))}`);
        this.deps.ptyWrite(data);
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(this.tag, `WebSocket 断开: ${ip} (剩余: ${this.clients.size})`);
      });
    });
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
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.server.close();
    this.wss.close();
    logger.info(this.tag, 'Web 终端已停止');
  }

  /** 前端终端页面 */
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
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .header {
    background: #16213e;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid #0f3460;
    flex-shrink: 0;
  }
  .header .logo {
    font-size: 18px;
    font-weight: bold;
    color: #e94560;
  }
  .header .info {
    font-size: 12px;
    color: #7f8c8d;
  }
  .header .status {
    margin-left: auto;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2ecc71;
  }
  .status-dot.disconnected { background: #e74c3c; }
  #terminal-container {
    flex: 1;
    padding: 4px;
    overflow: hidden;
  }
  .xterm { height: 100%; }
  .footer {
    background: #16213e;
    padding: 6px 16px;
    font-size: 11px;
    color: #555;
    border-top: 1px solid #0f3460;
    display: flex;
    justify-content: space-between;
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <div class="header">
    <span class="logo">🦐 ${botName}</span>
    <span class="info">Claude Code Web Terminal</span>
    <span class="status">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">连接中...</span>
    </span>
  </div>
  <div id="terminal-container"></div>
  <div class="footer">
    <span>WebSocket <span id="wsStatus">connecting</span></span>
    <span><kbd>Ctrl+C</kbd> 中断 · <kbd>Ctrl+D</kbd> 退出</span>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const term = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e94560',
        selectionBackground: '#0f3460',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      cols: 120,
      rows: 40,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    setTimeout(() => fitAddon.fit(), 100);

    let ws = null;
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    const dot = document.getElementById('statusDot');
    const stText = document.getElementById('statusText');
    const wsStatus = document.getElementById('wsStatus');

    function connect() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      ws = new WebSocket('ws://' + location.host);

      ws.onopen = () => {
        reconnectDelay = 1000;
        dot.className = 'status-dot';
        stText.textContent = '已连接';
        wsStatus.textContent = 'connected';
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') term.write(e.data);
      };
      ws.onclose = () => {
        dot.className = 'status-dot disconnected';
        stText.textContent = '重连中...';
        wsStatus.textContent = 'reconnecting';
        term.write('\\r\\n\\x1b[33m--- 连接断开，自动重连中 ---\\x1b[0m\\r\\n');
        scheduleReconnect();
      };
      ws.onerror = () => {
        dot.className = 'status-dot disconnected';
        stText.textContent = '连接错误';
      };
    }

    function scheduleReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        stText.textContent = '重连中 (' + (reconnectDelay/1000) + 's)...';
        connect();
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      }, reconnectDelay);
    }

    connect();

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    window.addEventListener('resize', () => fitAddon.fit());
  </script>
</body>
</html>`;
  }
}
