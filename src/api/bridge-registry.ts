import type { Logger } from '../utils/logger.js';

export interface BridgeBinding {
  chatId: string;
  connectedAt: number;
  lastHeartbeat: number;
  messageQueue: BridgeMessage[];
  sseResolve: ((msg: BridgeMessage) => void) | null;
}

export interface BridgeMessage {
  source: 'feishu';
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
}

export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;

export class BridgeRegistry {
  private bindings = new Map<string, BridgeBinding>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private logger: Logger) {
    this.heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  /** Check if a chatId has an active bridge binding. */
  hasBinding(chatId: string): boolean {
    return this.bindings.has(chatId);
  }

  /** Register a new bridge binding for the given chatId. */
  register(chatId: string): BridgeBinding {
    const now = Date.now();
    const binding: BridgeBinding = {
      chatId,
      connectedAt: now,
      lastHeartbeat: now,
      messageQueue: [],
      sseResolve: null,
    };
    this.bindings.set(chatId, binding);
    this.logger.info({ chatId }, 'Bridge binding registered');
    return binding;
  }

  /** Unregister a bridge binding and clean up any pending resolve. */
  unregister(chatId: string): boolean {
    const binding = this.bindings.get(chatId);
    if (!binding) return false;

    // If there's a pending long-poll, resolve with null to signal disconnect
    if (binding.sseResolve) {
      binding.sseResolve(null as unknown as BridgeMessage);
      binding.sseResolve = null;
    }

    this.bindings.delete(chatId);
    this.logger.info({ chatId }, 'Bridge binding unregistered');
    return true;
  }

  /** Update the last heartbeat timestamp for a binding. */
  heartbeat(chatId: string): boolean {
    const binding = this.bindings.get(chatId);
    if (!binding) return false;
    binding.lastHeartbeat = Date.now();
    return true;
  }

  /** Enqueue a Feishu message for the bridge to consume. */
  enqueueMessage(chatId: string, message: BridgeMessage): boolean {
    const binding = this.bindings.get(chatId);
    if (!binding) return false;

    // If there's a pending long-poll waiter, resolve immediately
    if (binding.sseResolve) {
      const resolve = binding.sseResolve;
      binding.sseResolve = null;
      resolve(message);
      return true;
    }

    binding.messageQueue.push(message);
    return true;
  }

  /**
   * Wait for a message from the given chatId.
   * Returns immediately if the queue has items.
   * Otherwise waits up to 25 seconds for a new message.
   * Returns null if timeout expires.
   */
  async waitForMessage(chatId: string): Promise<BridgeMessage | null> {
    const binding = this.bindings.get(chatId);
    if (!binding) return null;

    // Return immediately if queue has items
    if (binding.messageQueue.length > 0) {
      return binding.messageQueue.shift()!;
    }

    // Wait for a new message (up to 25 seconds)
    return new Promise<BridgeMessage | null>((resolve) => {
      binding.sseResolve = resolve;
      const timeoutMs = 25_000;
      const timer = setTimeout(() => {
        if (binding.sseResolve === resolve) {
          binding.sseResolve = null;
          resolve(null);
        }
      }, timeoutMs);

      // Wrap the resolve so we can clear the timer when resolved early
      const originalResolve = resolve;
      binding.sseResolve = (msg: BridgeMessage) => {
        clearTimeout(timer);
        binding.sseResolve = null;
        originalResolve(msg);
      };
    });
  }

  /** Return a list of all active bindings (without internal resolve). */
  listBindings(): Array<{
    chatId: string;
    connectedAt: number;
    lastHeartbeat: number;
    queueLength: number;
  }> {
    return Array.from(this.bindings.values()).map((b) => ({
      chatId: b.chatId,
      connectedAt: b.connectedAt,
      lastHeartbeat: b.lastHeartbeat,
      queueLength: b.messageQueue.length,
    }));
  }

  /** Remove bindings that have not sent a heartbeat within the timeout. */
  private checkHeartbeats(): void {
    const now = Date.now();
    for (const [chatId, binding] of this.bindings) {
      if (now - binding.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.logger.warn({ chatId, lastHeartbeat: binding.lastHeartbeat }, 'Bridge binding heartbeat timeout, removing');
        if (binding.sseResolve) {
          binding.sseResolve(null as unknown as BridgeMessage);
          binding.sseResolve = null;
        }
        this.bindings.delete(chatId);
      }
    }
  }

  /** Clean up all bindings and stop the heartbeat checker. */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const binding of this.bindings.values()) {
      if (binding.sseResolve) {
        binding.sseResolve(null as unknown as BridgeMessage);
        binding.sseResolve = null;
      }
    }
    this.bindings.clear();
    this.logger.info('BridgeRegistry destroyed');
  }
}
