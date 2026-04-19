import type * as http from 'node:http';
import { jsonResponse, readBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleBridgeRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { bridgeRegistry, registry, logger } = ctx;
  if (!bridgeRegistry) return false;

  // POST /bridge/register
  if (method === 'POST' && url === '/bridge/register') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    const ok = bridgeRegistry.register(chatId);
    if (!ok) { jsonResponse(res, 409, { error: 'chatId already bound to another bridge' }); return true; }
    jsonResponse(res, 200, { status: 'registered', chatId });
    return true;
  }

  // POST /bridge/unregister
  if (method === 'POST' && url === '/bridge/unregister') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    bridgeRegistry.unregister(chatId);
    jsonResponse(res, 200, { status: 'unregistered', chatId });
    return true;
  }

  // POST /bridge/heartbeat
  if (method === 'POST' && url === '/bridge/heartbeat') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }
    const { chatId } = parsed;
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    bridgeRegistry.heartbeat(chatId);
    jsonResponse(res, 200, { status: 'ok' });
    return true;
  }

  // GET /bridge/messages/:chatId — long poll for Feishu messages
  if (method === 'GET' && url.startsWith('/bridge/messages/')) {
    const chatId = url.slice('/bridge/messages/'.length).split('?')[0];
    if (!chatId || !bridgeRegistry.hasBinding(chatId)) {
      jsonResponse(res, 404, { error: 'No bridge bound for this chatId' });
      return true;
    }
    const msg = await bridgeRegistry.waitForMessage(chatId);
    if (msg) {
      jsonResponse(res, 200, msg);
    } else {
      res.writeHead(204);
      res.end();
    }
    return true;
  }

  // POST /bridge/events/:chatId — bridge sends Claude output events
  if (method === 'POST' && url.startsWith('/bridge/events/')) {
    const chatId = url.slice('/bridge/events/'.length).split('?')[0];
    if (!chatId) { jsonResponse(res, 400, { error: 'Missing chatId' }); return true; }
    const body = await readBody(req);
    let event: any;
    try { event = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return true; }

    const botName = event.botName;
    if (!botName) { jsonResponse(res, 400, { error: 'Missing botName' }); return true; }
    const bot = registry.get(botName);
    if (!bot) { jsonResponse(res, 404, { error: `Bot ${botName} not found` }); return true; }

    try {
      if (event.type === 'initial') {
        const messageId = await bot.sender.sendCard(chatId, event.state);
        jsonResponse(res, 200, { messageId });
      } else if (event.type === 'update' && event.messageId) {
        await bot.sender.updateCard(event.messageId, event.state);
        jsonResponse(res, 200, { ok: true });
      } else if (event.type === 'complete' && event.messageId) {
        await bot.sender.updateCard(event.messageId, event.state);
        if (event.terminalInput) {
          await bot.sender.sendTextNotice(chatId, '[终端] ' + event.terminalInput, '', 'blue');
        }
        jsonResponse(res, 200, { ok: true });
      } else if (event.type === 'terminal_input') {
        await bot.sender.sendTextNotice(chatId, '[终端] ' + event.text, '', 'blue');
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 400, { error: `Unknown event type: ${event.type}` });
      }
    } catch (err: any) {
      logger.error({ err, chatId }, 'Failed to forward bridge event to Feishu');
      jsonResponse(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /bridge/status
  if (method === 'GET' && url === '/bridge/status') {
    const bindings = bridgeRegistry.listBindings();
    jsonResponse(res, 200, { bridges: bindings });
    return true;
  }

  // GET /bridge/chats — list known chats for --pick
  if (method === 'GET' && url === '/bridge/chats') {
    const chats = ctx.knownChatsStore?.list() ?? [];
    jsonResponse(res, 200, { chats });
    return true;
  }

  return false;
}
