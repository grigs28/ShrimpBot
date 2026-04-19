import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';

export interface ParsedEvent {
  type:
    | 'system'
    | 'assistant_text'
    | 'assistant_tool_use'
    | 'tool_result'
    | 'result'
    | 'stream_delta'
    | 'stream_start'
    | 'stream_stop'
    | 'message_start'
    | 'message_delta'
    | 'unknown';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  isError?: boolean;
  resultText?: string;
  inputTokens?: number;
  outputTokens?: number;
  raw: unknown;
}

export class StreamJSONParser {
  private handler?: (event: ParsedEvent) => void;

  onEvent(handler: (event: ParsedEvent) => void): void {
    this.handler = handler;
  }

  start(process: ChildProcess): void {
    if (!process.stdout) {
      return;
    }

    const rl = createInterface({
      input: process.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      this.parseLine(line);
    });

    rl.on('close', () => {
      // Stream ended
    });
  }

  private parseLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = obj.type;
    if (typeof type !== 'string') {
      return;
    }

    const events = this.buildEvents(type, obj);
    if (events.length > 0 && this.handler) {
      for (const event of events) {
        this.handler(event);
      }
    }
  }

  private buildEvents(type: string, obj: Record<string, unknown>): ParsedEvent[] {
    switch (type) {
      case 'system': {
        return [
          {
            type: 'system',
            sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
            raw: obj,
          },
        ];
      }

      case 'assistant': {
        return this.parseAssistantMessage(obj);
      }

      case 'result': {
        const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
        const resultText = typeof obj.result === 'string' ? obj.result : undefined;
        const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
        const durationMs = typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined;
        return [
          {
            type: 'result',
            resultText,
            costUsd,
            durationMs,
            isError: subtype !== 'success',
            raw: obj,
          },
        ];
      }

      case 'stream_event': {
        return this.parseStreamEvent(obj);
      }

      default: {
        return [
          {
            type: 'unknown',
            raw: obj,
          },
        ];
      }
    }
  }

  private parseAssistantMessage(obj: Record<string, unknown>): ParsedEvent[] {
    const message = obj.message;
    if (!message || typeof message !== 'object') {
      return [];
    }

    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return [];
    }

    const events: ParsedEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const b = block as Record<string, unknown>;
      const blockType = b.type;

      if (blockType === 'text' && typeof b.text === 'string') {
        events.push({
          type: 'assistant_text',
          text: b.text,
          raw: obj,
        });
      } else if (blockType === 'tool_use') {
        events.push({
          type: 'assistant_tool_use',
          toolName: typeof b.name === 'string' ? b.name : undefined,
          toolInput: b.input,
          toolUseId: typeof b.id === 'string' ? b.id : undefined,
          raw: obj,
        });
      } else if (blockType === 'tool_result') {
        events.push({
          type: 'tool_result',
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
          raw: obj,
        });
      }
    }

    return events;
  }

  private parseStreamEvent(obj: Record<string, unknown>): ParsedEvent[] {
    const event = obj.event;
    if (!event || typeof event !== 'object') {
      return [];
    }

    const e = event as Record<string, unknown>;
    const eventType = e.type;

    if (eventType === 'content_block_start') {
      const block = e.content_block;
      let toolName: string | undefined;
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          toolName = b.name;
        }
      }
      return [
        {
          type: 'stream_start',
          toolName,
          raw: obj,
        },
      ];
    }

    if (eventType === 'content_block_delta') {
      const delta = e.delta;
      if (delta && typeof delta === 'object') {
        const d = delta as Record<string, unknown>;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return [
            {
              type: 'stream_delta',
              text: d.text,
              raw: obj,
            },
          ];
        }
      }
      return [];
    }

    if (eventType === 'content_block_stop') {
      return [
        {
          type: 'stream_stop',
          raw: obj,
        },
      ];
    }

    if (eventType === 'message_start') {
      let inputTokens: number | undefined;
      const msg = e.message;
      if (msg && typeof msg === 'object') {
        const usage = (msg as Record<string, unknown>).usage;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          const inputTokensRaw = u.input_tokens;
          if (typeof inputTokensRaw === 'number') {
            inputTokens = inputTokensRaw;
          }
        }
      }
      return [
        {
          type: 'message_start',
          inputTokens,
          raw: obj,
        },
      ];
    }

    if (eventType === 'message_delta') {
      let outputTokens: number | undefined;
      const usage = e.usage;
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        const outputTokensRaw = u.output_tokens;
        if (typeof outputTokensRaw === 'number') {
          outputTokens = outputTokensRaw;
        }
      }
      return [
        {
          type: 'message_delta',
          outputTokens,
          raw: obj,
        },
      ];
    }

    return [];
  }
}
