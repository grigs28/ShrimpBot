import type { Session } from '../types/index.js';

export class SessionService {
  private sessions: Map<string, Session> = new Map();

  getOrCreate(chatId: string): Session {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const session: Session = {
      chatId,
      lastMessageTimestamp: 0,
      createdAt: Date.now(),
    };
    this.sessions.set(chatId, session);
    return session;
  }

  updateTimestamp(chatId: string, timestamp: number): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.lastMessageTimestamp = timestamp;
    }
  }

  get(chatId: string): Session | undefined {
    return this.sessions.get(chatId);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }
}
