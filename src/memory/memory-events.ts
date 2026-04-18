import { EventEmitter } from 'node:events';

export interface MemoryChangeEvent {
  type: 'document_created' | 'document_updated' | 'document_deleted' | 'folder_created' | 'folder_deleted';
  documentId?: string;
  folderId?: string;
}

class MemoryEventBus extends EventEmitter {
  emitChange(event: MemoryChangeEvent): void {
    this.emit('change', event);
  }

  onChange(handler: (event: MemoryChangeEvent) => void): this {
    return this.on('change', handler);
  }
}

/** Singleton event bus for MetaMemory write operations. */
export const memoryEvents = new MemoryEventBus();
