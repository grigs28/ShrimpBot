/**
 * Feishu confirmation module for non yes/no Claude Code questions.
 *
 * When Claude Code asks questions that aren't simple tool permission approvals
 * (e.g., asking for user input, clarification, or decisions beyond allow/deny),
 * this module sends interactive Feishu cards with input fields and waits for
 * user responses.
 *
 * It also handles task success/failure notification cards.
 */

import type { Logger } from '../utils/logger.js';
import type { MessageSender } from '../feishu/message-sender.js';
import type { PendingQuestion } from '../types.js';
import { buildConfirmationCard, buildTaskResultCard } from '../feishu/card-builder.js';

/** Callback type for when a confirmation response is received. */
export type ConfirmCallback = (response: string) => void;

interface PendingConfirmation {
  resolve: (response: string) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  chatId: string;
}

export class FeishuConfirm {
  /** Map of confirmation ID to pending confirmation. */
  private pendingConfirmations = new Map<string, PendingConfirmation>();

  /** Map of chatId to its active confirmation ID (one confirmation per chat at a time). */
  private chatConfirmations = new Map<string, string>();

  private confirmationTimeoutMs: number;

  constructor(
    private sender: MessageSender,
    private logger: Logger,
    timeoutMs?: number,
  ) {
    this.confirmationTimeoutMs = timeoutMs ?? 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Send a confirmation card to Feishu for a non-simple question and wait for response.
   * The question is displayed both in the terminal (via existing card) and as an
   * interactive Feishu card with an input field.
   *
   * @param chatId - The Feishu chat ID to send the card to
   * @param question - The pending question from Claude
   * @param context - Additional context (bot name, task description, etc.)
   * @returns Promise that resolves with the user's response
   */
  async sendConfirmationAndWait(
    chatId: string,
    question: PendingQuestion,
    context?: { botName?: string; taskPrompt?: string },
  ): Promise<string> {
    const confirmId = `confirm-${chatId}-${Date.now()}`;

    this.logger.info({ chatId, confirmId, toolUseId: question.toolUseId }, 'Sending Feishu confirmation card');

    // Build and send the interactive confirmation card
    const cardContent = buildConfirmationCard(question, confirmId, context);
    const messageId = await this.sender.sendCard(chatId, cardContent);

    if (!messageId) {
      this.logger.error({ chatId }, 'Failed to send confirmation card, auto-answering');
      return this.buildAutoAnswer(question);
    }

    // Create promise that will be resolved when user responds
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.logger.warn({ chatId, confirmId }, 'Confirmation timeout, auto-answering');
        this.pendingConfirmations.delete(confirmId);
        this.chatConfirmations.delete(chatId);
        resolve(this.buildAutoAnswer(question));
      }, this.confirmationTimeoutMs);

      const pending: PendingConfirmation = {
        resolve: (response: string) => {
          clearTimeout(timeoutId);
          this.pendingConfirmations.delete(confirmId);
          this.chatConfirmations.delete(chatId);
          resolve(response);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          this.pendingConfirmations.delete(confirmId);
          this.chatConfirmations.delete(chatId);
          reject(err);
        },
        timeoutId,
        chatId,
      };

      this.pendingConfirmations.set(confirmId, pending);
      this.chatConfirmations.set(chatId, confirmId);
    });
  }

  /**
   * Handle a user response received from Feishu for a pending confirmation.
   * Called when the Feishu event handler receives a card action callback.
   *
   * @param confirmId - The confirmation ID from the card action
   * @param response - The user's response text
   * @returns true if the confirmation was found and resolved
   */
  handleResponse(confirmId: string, response: string): boolean {
    const pending = this.pendingConfirmations.get(confirmId);
    if (!pending) {
      this.logger.warn({ confirmId }, 'No pending confirmation found for response');
      return false;
    }

    this.logger.info({ confirmId, chatId: pending.chatId, responseLength: response.length }, 'Confirmation response received');
    pending.resolve(response);
    return true;
  }

  /**
   * Handle a text message response for a pending confirmation in a chat.
   * This is used when the user simply types a reply in the chat instead of
   * using the card input field.
   *
   * @param chatId - The chat ID
   * @param response - The user's response text
   * @returns true if there was a pending confirmation for this chat
   */
  handleTextResponse(chatId: string, response: string): boolean {
    const confirmId = this.chatConfirmations.get(chatId);
    if (!confirmId) return false;
    return this.handleResponse(confirmId, response);
  }

  /**
   * Check if a chat has a pending confirmation.
   */
  hasPendingConfirmation(chatId: string): boolean {
    return this.chatConfirmations.has(chatId);
  }

  /**
   * Send a task result notification card to Feishu.
   * Called when a task completes (success or failure).
   *
   * @param chatId - The Feishu chat ID to send the card to
   * @param result - Task result details
   */
  async sendTaskResultNotification(
    chatId: string,
    result: {
      success: boolean;
      taskPrompt: string;
      responsePreview?: string;
      durationMs?: number;
      costUsd?: number;
      errorMessage?: string;
      botName?: string;
      model?: string;
    },
  ): Promise<void> {
    try {
      const cardContent = buildTaskResultCard(result);
      await this.sender.sendCard(chatId, cardContent);
      this.logger.info({ chatId, success: result.success }, 'Task result notification sent');
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to send task result notification');
    }
  }

  /**
   * Build auto-answer JSON when user doesn't respond in time.
   */
  private buildAutoAnswer(question: PendingQuestion): string {
    const answers: Record<string, string> = {};
    for (const q of question.questions) {
      answers[q.header] = '用户未及时回复，请自行判断继续';
    }
    return JSON.stringify({ answers });
  }

  /**
   * Clean up all pending confirmations (for shutdown).
   */
  destroy(): void {
    for (const [, pending] of this.pendingConfirmations) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Shutting down'));
    }
    this.pendingConfirmations.clear();
    this.chatConfirmations.clear();
  }
}
