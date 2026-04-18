// Re-export shared types so existing imports from this module continue to work
export type { CardStatus, ToolCall, PendingQuestion, CardState } from '../types.js';
import type { CardState, CardStatus, PendingQuestion } from '../types.js';

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
};

const MAX_CONTENT_LENGTH = 28000;

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const half = Math.floor(MAX_CONTENT_LENGTH / 2) - 50;
  return (
    text.slice(0, half) +
    '\n\n... (content truncated) ...\n\n' +
    text.slice(-half)
  );
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Tool calls section
  if (state.toolCalls.length > 0) {
    const toolLines = state.toolCalls.map((t) => {
      const icon = t.status === 'running' ? '⏳' : '✅';
      return `${icon} **${t.name}** ${t.detail}`;
    });
    elements.push({
      tag: 'markdown',
      content: toolLines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // Response content
  if (state.responseText) {
    elements.push({
      tag: 'markdown',
      content: truncateContent(state.responseText),
    });
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: '_Claude is thinking..._',
    });
  }

  // Pending question section
  if (state.pendingQuestion) {
    elements.push({ tag: 'hr' });
    const questionLines: string[] = [];
    for (const q of state.pendingQuestion.questions) {
      questionLines.push(`**[${q.header}] ${q.question}**`);
      questionLines.push('');
      q.options.forEach((opt, i) => {
        questionLines.push(`**${i + 1}.** ${opt.label} — _${opt.description}_`);
      });
      questionLines.push(`**${q.options.length + 1}.** Other（输入自定义回答）`);
      questionLines.push('');
    }
    questionLines.push('_回复数字选择，或直接输入自定义答案_');
    elements.push({
      tag: 'markdown',
      content: questionLines.join('\n'),
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note — show context usage during all states, full stats on complete/error
  {
    const parts: string[] = [];
    if (state.totalTokens && state.contextWindow) {
      const pct = Math.round((state.totalTokens / state.contextWindow) * 100);
      const tokensK = state.totalTokens >= 1000
        ? `${(state.totalTokens / 1000).toFixed(1)}k`
        : `${state.totalTokens}`;
      const ctxK = `${Math.round(state.contextWindow / 1000)}k`;
      parts.push(`ctx: ${tokensK}/${ctxK} (${pct}%)`);
    }
    if (state.status === 'complete' || state.status === 'error') {
      if (state.sessionCostUsd != null) {
        parts.push(`$${state.sessionCostUsd.toFixed(2)}`);
      }
      if (state.model) {
        parts.push(state.model.replace(/^claude-/, ''));
      }
      if (state.durationMs !== undefined) {
        parts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
      }
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: parts.join(' | '),
          },
        ],
      });
    }
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: config.color,
      title: {
        content: `${config.icon} ${config.title}`,
        tag: 'plain_text',
      },
    },
    elements,
  };

  return JSON.stringify(card);
}

export function buildHelpCard(): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📖 Help',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Available Commands:**',
          '`/reset` - Clear session, start fresh',
          '`/stop` - Abort current running task',
          '`/status` - Show current session info',
          '`/memory` - Memory document commands',
          '`/help` - Show this help message',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with Claude Code.',
          'Each chat has an independent session with a fixed working directory.',
          '',
          '**Memory Commands:**',
          '`/memory list` - Show folder tree',
          '`/memory search <query>` - Search documents',
          '`/memory status` - Server health check',
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildStatusCard(
  userId: string,
  workingDirectory: string,
  sessionId: string | undefined,
  isRunning: boolean,
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📊 Status',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**User:** \`${userId}\``,
          `**Working Directory:** \`${workingDirectory}\``,
          `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildTextCard(title: string, content: string, color: string = 'blue'): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build an interactive Feishu card for non-simple confirmation questions.
 * Includes question text, options (if any), and instructions to reply.
 * The card uses a distinctive yellow/amber header to distinguish from normal task cards.
 */
export function buildConfirmationCard(
  question: PendingQuestion,
  confirmId: string,
  context?: { botName?: string; taskPrompt?: string },
): string {
  const elements: unknown[] = [];

  // Show bot context if available
  if (context?.botName) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `Bot: ${context.botName}`,
        },
      ],
    });
  }

  // Show task prompt for context (truncated)
  if (context?.taskPrompt) {
    const truncated = context.taskPrompt.length > 200
      ? context.taskPrompt.slice(0, 200) + '...'
      : context.taskPrompt;
    elements.push({
      tag: 'markdown',
      content: `**Task:** ${truncated}`,
    });
    elements.push({ tag: 'hr' });
  }

  // Question content
  for (const q of question.questions) {
    elements.push({
      tag: 'markdown',
      content: `**${q.question}**`,
    });

    if (q.options && q.options.length > 0) {
      elements.push({ tag: 'markdown', content: '' });
      const optionLines: string[] = [];
      q.options.forEach((opt, i) => {
        optionLines.push(`${i + 1}. **${opt.label}**${opt.description ? ` — _${opt.description}_` : ''}`);
      });
      optionLines.push(`${q.options.length + 1}. _自定义回答_`);
      elements.push({
        tag: 'markdown',
        content: optionLines.join('\n'),
      });
    }
  }

  elements.push({ tag: 'hr' });

  // Instructions
  elements.push({
    tag: 'markdown',
    content: '_请直接回复数字选择或输入自定义答案_\n_Reply with option number or custom answer_',
  });

  // Confirmation ID as note (for tracking)
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `ID: ${confirmId}`,
      },
    ],
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: {
        content: '🟠 需要确认 / Confirmation Required',
        tag: 'plain_text',
      },
    },
    elements,
  };

  return JSON.stringify(card);
}

/**
 * Build a Feishu card for task completion/failure notification.
 * Green for success, red for failure.
 */
export function buildTaskResultCard(result: {
  success: boolean;
  taskPrompt: string;
  responsePreview?: string;
  durationMs?: number;
  costUsd?: number;
  errorMessage?: string;
  botName?: string;
  model?: string;
}): string {
  const color = result.success ? 'green' : 'red';
  const title = result.success
    ? '🟢 任务完成 / Task Complete'
    : '🔴 任务失败 / Task Failed';

  const elements: unknown[] = [];

  // Bot name
  if (result.botName) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `Bot: ${result.botName}` },
      ],
    });
  }

  // Task description
  const truncatedPrompt = result.taskPrompt.length > 300
    ? result.taskPrompt.slice(0, 300) + '...'
    : result.taskPrompt;
  elements.push({
    tag: 'markdown',
    content: `**任务描述:**\n${truncatedPrompt}`,
  });

  elements.push({ tag: 'hr' });

  // Response preview (success) or error message (failure)
  if (result.success && result.responsePreview) {
    const truncated = result.responsePreview.length > 500
      ? result.responsePreview.slice(0, 500) + '...'
      : result.responsePreview;
    elements.push({
      tag: 'markdown',
      content: `**Result:**\n${truncated}`,
    });
  } else if (!result.success && result.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${result.errorMessage}`,
    });
  }

  // Stats footer
  const statsParts: string[] = [];

  // Status
  const statusText = result.success ? 'Success' : 'Failed';
  statsParts.push(`Status: ${statusText}`);

  // Duration
  if (result.durationMs !== undefined) {
    if (result.durationMs >= 60_000) {
      statsParts.push(`Duration: ${(result.durationMs / 60_000).toFixed(1)}min`);
    } else {
      statsParts.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    }
  }

  // Cost
  if (result.costUsd !== undefined) {
    statsParts.push(`Cost: $${result.costUsd.toFixed(4)}`);
  }

  // Model
  if (result.model) {
    statsParts.push(`Model: ${result.model.replace(/^claude-/, '')}`);
  }

  if (statsParts.length > 0) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: statsParts.join(' | ') },
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: 'plain_text',
      },
    },
    elements,
  };

  return JSON.stringify(card);
}
