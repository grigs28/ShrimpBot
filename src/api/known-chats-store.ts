import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

export interface KnownChat {
  chatId: string;
  chatType: string;
  userId: string;
  /** Best-effort user display name from Feishu */
  userName?: string;
  lastActivity: number;
  firstSeen: number;
}

/**
 * Persists known Feishu chatIds so `shrimpbot-bridge --pick` can list them.
 * Stored as a JSON file in the data directory.
 */
export class KnownChatsStore {
  private chats = new Map<string, KnownChat>();
  private filePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dataDir: string, private logger: Logger) {
    this.filePath = path.join(dataDir, 'known-chats.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const arr = JSON.parse(raw) as KnownChat[];
        for (const chat of arr) {
          this.chats.set(chat.chatId, chat);
        }
        this.logger.info({ count: this.chats.size }, 'Known chats loaded');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load known chats, starting fresh');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  /** Persist to disk (debounced). */
  flush(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.chats.values());
      fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2));
      this.dirty = false;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to save known chats');
    }
  }

  /**
   * Record a chat from an incoming message. Updates if chatId already known.
   * Returns true if this was a new chatId.
   */
  record(chatId: string, chatType: string, userId: string, userName?: string): boolean {
    const existing = this.chats.get(chatId);
    const isNew = !existing;

    this.chats.set(chatId, {
      chatId,
      chatType,
      userId,
      userName: userName || existing?.userName,
      lastActivity: Date.now(),
      firstSeen: existing?.firstSeen ?? Date.now(),
    });

    this.dirty = true;
    this.scheduleSave();

    if (isNew) {
      this.logger.info({ chatId, chatType, userId }, 'New chat discovered');
    }
    return isNew;
  }

  /** Get all known chats, sorted by last activity (most recent first). */
  list(): KnownChat[] {
    return Array.from(this.chats.values()).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  destroy(): void {
    this.flush();
    if (this.saveTimer) clearTimeout(this.saveTimer);
  }
}
